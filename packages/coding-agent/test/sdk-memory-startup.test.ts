import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const HOLD_WINDOW_MS = 250;
const SETTLE_BOUND_MS = 2_000;

/** Real time is required: no event signals that a prompt correctly remains parked. */
async function staysPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return !(await Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]));
}

describe("createAgentSession memory backend startup with auto-learn", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	const tempDirs: TempDir[] = [];
	const releaseGates: Array<() => void> = [];
	const pendingCreations: Promise<AgentSession>[] = [];

	afterEach(async () => {
		for (const release of releaseGates.splice(0)) release();
		await Promise.allSettled(pendingCreations.splice(0));
		for (const session of sessions.splice(0)) await session.dispose();
		for (const storage of authStorages.splice(0)) storage.close();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
		clearCustomApis();
		vi.restoreAllMocks();
	});

	function fakeBackend(start: MemoryBackend["start"]): MemoryBackend {
		return {
			id: "local",
			start,
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
		};
	}

	async function createAutolearnSession(api: string, onStream: () => void): Promise<AgentSession> {
		const tempDir = TempDir.createSync("@pi-memory-startup-");
		tempDirs.push(tempDir);
		registerCustomApi(api, () => {
			onStream();
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "memory-startup",
			name: "Memory startup",
			api,
			provider: "memory-startup-provider",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime(model.provider, "test-key");
		const creating = createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"autolearn.enabled": true,
				"memory.backend": "local",
			}),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		const pending = creating.then(({ session }) => {
			sessions.push(session);
			return session;
		});
		pendingCreations.push(pending);
		return pending;
	}

	it("returns the session while the backend is still starting and holds the first prompt until it is ready", async () => {
		const events: string[] = [];
		const release = Promise.withResolvers<void>();
		releaseGates.push(() => release.resolve());
		const modelEntered = Promise.withResolvers<void>();
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => {
				events.push("start");
				await release.promise;
				events.push("started");
			}),
		);

		const session = await createAutolearnSession("test-memory-startup-held", () => {
			events.push("model");
			modelEntered.resolve();
		});
		events.push("created");

		try {
			const prompting = session.prompt("hello");
			expect(await staysPending(modelEntered.promise, HOLD_WINDOW_MS)).toBe(true);
			release.resolve();
			await prompting;
		} finally {
			release.resolve();
		}
		expect(events).toEqual(["start", "created", "started", "model"]);
	});

	it("reports a failed backend start once, at the first prompt, and keeps the session usable", async () => {
		const events: string[] = [];
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => {
				throw new Error("backend load failed");
			}),
		);

		// The start fails before anything has subscribed, as it can before the
		// interactive UI attaches; the failure must still reach the user.
		const session = await createAutolearnSession("test-memory-startup-failed", () => events.push("model"));
		await session.settleMemoryBackend();
		session.subscribe(event => {
			if (event.type !== "notice") return;
			notices.push(event);
			events.push("notice");
		});
		await session.prompt("hello");
		await session.prompt("again");

		expect(events).toEqual(["notice", "model", "model"]);
		expect(notices[0]?.level).toBe("error");
	});

	it("releases a prompt aborted while it waits for the start and leaves the failure for the next prompt", async () => {
		const events: string[] = [];
		const release = Promise.withResolvers<void>();
		releaseGates.push(() => release.resolve());
		const modelEntered = Promise.withResolvers<void>();
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => {
				await release.promise;
				throw new Error("backend load failed");
			}),
		);
		const session = await createAutolearnSession("test-memory-startup-abort", () => {
			events.push("model");
			modelEntered.resolve();
		});
		session.subscribe(event => {
			if (event.type === "notice") events.push("notice");
		});

		try {
			const prompting = session.prompt("hello");
			// Abort only once the prompt has had time to reach the wait.
			expect(await staysPending(modelEntered.promise, HOLD_WINDOW_MS)).toBe(true);
			await session.abort();
			await withTimeout(prompting, SETTLE_BOUND_MS, "Aborted prompt kept waiting for the memory backend start");
			expect(events).toEqual([]);

			release.resolve();
			await session.prompt("again");
		} finally {
			release.resolve();
		}
		expect(events).toEqual(["notice", "model"]);
	});

	it("does not wait out a start that outlives disposal, and releases what it installs afterwards", async () => {
		const release = Promise.withResolvers<void>();
		releaseGates.push(() => release.resolve());
		const lateStartAborted = Promise.withResolvers<void>();
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async ({ session }) => {
				await release.promise;
				session.beginLocalMemoryStartup().addEventListener("abort", () => lateStartAborted.resolve(), {
					once: true,
				});
			}),
		);
		const modelEntered = Promise.withResolvers<void>();
		const session = await createAutolearnSession("test-memory-startup-dispose", () => modelEntered.resolve());

		try {
			const prompting = session.prompt("hello");
			expect(await staysPending(modelEntered.promise, HOLD_WINDOW_MS)).toBe(true);
			await withTimeout(
				session.dispose({ drainTimeoutMs: 20 }),
				SETTLE_BOUND_MS,
				"Dispose waited for the unreleased memory backend start",
			);
			await withTimeout(prompting, SETTLE_BOUND_MS, "Disposal left the held prompt pending");
		} finally {
			release.resolve();
		}
		await withTimeout(
			lateStartAborted.promise,
			SETTLE_BOUND_MS,
			"A start that outlived disposal left its backend state installed",
		);
	});

	it("does not enter the memory wait when disposal wins during prompt preprocessing", async () => {
		const releaseBackend = Promise.withResolvers<void>();
		const preprocessingStarted = Promise.withResolvers<void>();
		const releasePreprocessing = Promise.withResolvers<void>();
		releaseGates.push(
			() => releaseBackend.resolve(),
			() => releasePreprocessing.resolve(),
		);
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => releaseBackend.promise),
		);
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			preprocessingStarted.resolve();
			await releasePreprocessing.promise;
			return undefined;
		});
		let modelCalls = 0;
		const session = await createAutolearnSession("test-memory-startup-preprocessing", () => modelCalls++);
		const prompting = session.prompt("hello", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				},
			],
		});
		try {
			await withTimeout(preprocessingStarted.promise, SETTLE_BOUND_MS, "Prompt preprocessing did not start");
			const disposing = session.dispose({ drainTimeoutMs: 20 });
			releasePreprocessing.resolve();
			await withTimeout(prompting, SETTLE_BOUND_MS, "Disposed prompt entered the held backend wait");
			await withTimeout(disposing, SETTLE_BOUND_MS, "Disposal waited for the backend gate");
			expect(modelCalls).toBe(0);
		} finally {
			releasePreprocessing.resolve();
			releaseBackend.resolve();
		}
	});

	it("drops command-generated prompt text when disposal wins during command execution", async () => {
		const releaseBackend = Promise.withResolvers<void>();
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		releaseGates.push(
			() => releaseBackend.resolve(),
			() => releaseCommand.resolve(),
		);
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => releaseBackend.promise),
		);
		let modelCalls = 0;
		const session = await createAutolearnSession("test-memory-startup-command", () => modelCalls++);
		session.setMCPPromptCommands([
			{
				path: "held-command",
				resolvedPath: "held-command",
				source: "project",
				command: {
					name: "held",
					description: "Return a prompt after release",
					async execute() {
						commandStarted.resolve();
						await releaseCommand.promise;
						return "hello";
					},
				},
			},
		]);
		const prompting = session.prompt("/held");
		try {
			await withTimeout(commandStarted.promise, SETTLE_BOUND_MS, "Command did not start");
			const disposing = session.dispose({ drainTimeoutMs: 20 });
			releaseCommand.resolve();
			await withTimeout(prompting, SETTLE_BOUND_MS, "Disposed command entered the held backend wait");
			await withTimeout(disposing, SETTLE_BOUND_MS, "Disposal waited for the command's backend gate");
			expect(modelCalls).toBe(0);
		} finally {
			releaseCommand.resolve();
			releaseBackend.resolve();
		}
	});

	it("drops a custom message when disposal wins while admission waits for maintenance", async () => {
		const releaseBackend = Promise.withResolvers<void>();
		const maintenanceStarted = Promise.withResolvers<void>();
		const releaseMaintenance = Promise.withResolvers<void>();
		releaseGates.push(
			() => releaseBackend.resolve(),
			() => releaseMaintenance.resolve(),
		);
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => releaseBackend.promise),
		);
		let modelCalls = 0;
		const session = await createAutolearnSession("test-memory-startup-custom", () => modelCalls++);
		vi.spyOn(SessionMaintenance.prototype, "waitForMaintenanceCleanup").mockImplementation(async () => {
			maintenanceStarted.resolve();
			await releaseMaintenance.promise;
			return undefined;
		});
		const prompting = session.promptCustomMessage({
			customType: "memory-startup-test",
			content: "hello",
			display: true,
		});
		try {
			await withTimeout(maintenanceStarted.promise, SETTLE_BOUND_MS, "Maintenance wait did not start");
			session.beginDispose();
			releaseMaintenance.resolve();
			const dispatched = await withTimeout(
				prompting,
				SETTLE_BOUND_MS,
				"Disposed custom message entered the held backend wait",
			);
			expect(modelCalls).toBe(0);
			expect(dispatched).toBe(false);
		} finally {
			releaseMaintenance.resolve();
			releaseBackend.resolve();
		}
	});

	it("drops a failed start's error once a re-apply replaces that backend", async () => {
		const events: string[] = [];
		const failing = fakeBackend(async () => {
			throw new Error("backend load failed");
		});
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockImplementation(async settings =>
			cfgMemoryBackend.get(settings) === "off" ? memoryBackend.offBackend : failing,
		);
		const session = await createAutolearnSession("test-memory-startup-reapply", () => events.push("model"));
		session.subscribe(event => {
			if (event.type === "notice") events.push("notice");
		});
		await session.settleMemoryBackend();

		cfgMemoryBackend.override(session.settings, "off");
		await session.settleMemoryBackend();
		await session.prompt("hello");

		expect(events).toEqual(["model"]);
	});

	it("shows a failed backend start on stderr in text print mode", async () => {
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(
			fakeBackend(async () => {
				throw new Error("backend load failed");
			}),
		);
		const session = await createAutolearnSession("test-memory-startup-print", () => {});
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			stdout.push(String(args[0]));
			const cb = args[args.length - 1];
			if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		});

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "hello" });

		expect(exitCode).toBe(0);
		expect(stderr.join("")).toContain("backend load failed");
		expect(stdout.join("")).toContain("ok");
	});
});
