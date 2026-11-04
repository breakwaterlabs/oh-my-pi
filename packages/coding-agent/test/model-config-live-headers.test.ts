import { afterEach, describe, expect, it } from "bun:test";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createConfigHeaderResolver,
	invalidateAllCommandConfigs,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";

const TEMP_ENV_KEYS: string[] = [];

function setEnv(key: string, value: string): void {
	TEMP_ENV_KEYS.push(key);
	process.env[key] = value;
}

function delayedValueCommand(value: string): string {
	if (process.platform !== "win32") return `!sleep 0.15; printf %s ${JSON.stringify(value)}`;
	return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
		`setTimeout(() => process.stdout.write(${JSON.stringify(value)}), 150)`,
	)}`;
}

afterEach(() => {
	for (const key of TEMP_ENV_KEYS.splice(0)) delete process.env[key];
	invalidateAllCommandConfigs();
});

describe("async config header materialization", () => {
	it("cancels while a header source remains pending instead of returning missing headers", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Record<string, string>>();
		const resolver = createConfigHeaderResolver([
			async () => {
				started.resolve();
				return release.promise;
			},
		]);
		if (!resolver) throw new Error("Expected a header resolver");
		const controller = new AbortController();
		const pending = resolver(controller.signal);
		try {
			await started.promise;
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			release.resolve({ Authorization: "too late" });
		}
	});

	it("merges nested resolvers with later sources taking precedence", async () => {
		const inner = createConfigHeaderResolver([{ "X-Tenant": "old", "X-Keep": "k" }]);
		const outer = createConfigHeaderResolver([inner, { "X-Tenant": "new" }]);

		expect(await outer?.()).toEqual({ "X-Tenant": "new", "X-Keep": "k" });
	});

	it("applies authHeader after explicit sources", async () => {
		setEnv("OMP_TEST_LIVE_KEY", "sekret");
		const resolver = createConfigHeaderResolver([{ Authorization: "wrong", "X-Keep": "k" }], {
			authHeader: true,
			apiKeyConfig: "OMP_TEST_LIVE_KEY",
		});

		expect(await resolver?.()).toEqual({ Authorization: "Bearer sekret", "X-Keep": "k" });
	});

	it("sends the explicit request key, not the configured key, as the authHeader bearer on the wire", async () => {
		const configuredKey = `configured-${crypto.randomUUID()}`;
		const requestKey = `request-${crypto.randomUUID()}`;
		const keyEnvName = "OMP_TEST_LIVE_WIRE_KEY";
		setEnv(keyEnvName, configuredKey);
		const seen: Array<string | null> = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				seen.push(req.headers.get("authorization"));
				return Response.json({ error: { message: "stop" } }, { status: 400 });
			},
		});
		const tempDir = await TempDir.create("@omp-live-wire-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelsPath = tempDir.join("models.json");
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						wire: {
							baseUrl: `http://127.0.0.1:${server.port}/v1`,
							api: "openai-completions",
							apiKey: keyEnvName,
							authHeader: true,
							models: [{ id: "wire-model", name: "Wire Model" }],
						},
					},
				}),
			);
			const registry = new ModelRegistry(authStorage, modelsPath, {
				cacheDbPath: tempDir.join("models.db"),
				fetch: () => Promise.reject(new Error("offline")),
			});
			const model = registry.find("wire", "wire-model");
			if (!model) throw new Error("Expected the configured wire model");
			const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

			await streamSimple(model, context, { apiKey: requestKey }).result();
			expect(seen).toEqual([`Bearer ${requestKey}`]);

			seen.length = 0;
			await stream(model, context, { apiKey: requestKey }).result();
			expect(seen).toEqual([`Bearer ${requestKey}`]);
		} finally {
			server.stop(true);
			authStorage?.close();
			await tempDir.remove();
		}
	});

	it("reads environment-backed values for every request", async () => {
		setEnv("OMP_TEST_LIVE_DYN", "v1");
		const resolver = createConfigHeaderResolver([{ "X-Dyn": "OMP_TEST_LIVE_DYN" }]);

		expect((await resolver?.())?.["X-Dyn"]).toBe("v1");
		setEnv("OMP_TEST_LIVE_DYN", "v2");
		expect((await resolver?.())?.["X-Dyn"]).toBe("v2");
	});

	it("does not block timers while a command-backed header resolves", async () => {
		const resolver = createConfigHeaderResolver([{ Authorization: delayedValueCommand("token") }]);
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 20);

		const pending = resolver?.();
		// Real time is intentional: fake timers cannot detect event-loop blocking
		// by a synchronous child-process API, which is the regression under test.
		await Bun.sleep(50);
		expect(timerFired).toBe(true);
		expect(await pending).toEqual({ Authorization: "token" });
		clearTimeout(timer);
	});

	it("resolves a deeply composed parent-child chain once per layer", async () => {
		const depth = 64;
		let baseReads = 0;
		const base = async (): Promise<Record<string, string>> => {
			baseReads++;
			return { "X-Base": "b" };
		};
		let resolver = createConfigHeaderResolver([base]);
		for (let i = 0; i < depth; i++) {
			resolver = createConfigHeaderResolver([resolver, { [`X-L${i}`]: String(i) }]);
		}

		const headers = await resolver?.();
		expect(Object.keys(headers ?? {})).toHaveLength(depth + 1);
		expect(headers?.["X-Base"]).toBe("b");
		expect(headers?.[`X-L${depth - 1}`]).toBe(String(depth - 1));
		expect(baseReads).toBe(1);
	});
});
