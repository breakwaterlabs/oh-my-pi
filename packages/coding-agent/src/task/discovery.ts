/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from OMP-native task-agent roots:
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *   - <ext>/agents/*.md for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/omp-plugins.ts`.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider. Direct cross-harness roots such as .claude/agents
 * are intentionally skipped because their frontmatter schema is not the OMP
 * task-agent contract.
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { boundSettings, isProviderEnabled, isUserSourceEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { pluginUsesClaudeModelDialect } from "../discovery/agent-plugin-format";
import { listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { cfgDisabledExtensions } from "../extensibility/settings";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentDefinition } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".omp";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	/**
	 * Non-bundled agents hidden by a `disabledExtensions` entry (`agent:<name>`), in
	 * discovery order, so `/extensions` can list them and offer re-enabling.
	 */
	disabledAgents?: AgentDefinition[];
	projectAgentsDir: string | null;
	/** Agent directories searched, in precedence order (for "unknown agent" diagnostics). */
	searchedDirs?: string[];
}

export interface DiscoverAgentsOptions {
	/**
	 * Disabled extension ids to apply instead of the bound settings' `disabledExtensions`.
	 * `agent:<name>` entries hide a discovered agent; bundled agents are never hidden here.
	 */
	disabledExtensions?: readonly string[];
}

/**
 * The `agent:<name>` entries of `disabledExtensions` that {@link discoverAgents} applies: the
 * explicit list when given, else the bound settings' value.
 */
export function disabledAgentExtensionIds(disabledExtensions?: readonly string[]): string[] {
	const settings = boundSettings();
	const ids = disabledExtensions ?? (settings ? cfgDisabledExtensions.get(settings) : undefined) ?? [];
	return ids.filter(id => id.startsWith("agent:"));
}

interface AgentDirectory {
	dir: string;
	source: AgentSource;
	/** Capability provider that owns this root, recorded on each agent for `/extensions`. */
	provider: string;
	ignoreModel?: boolean;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir({ dir, source, provider, ignoreModel }: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => {
					const agent = parseAgent(filePath, content, source, "warn");
					if (ignoreModel) agent.model = undefined;
					agent.provider = provider;
					return agent;
				})
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.omp/agents`, user `.omp/agents`,
 * OMP extension-package agents from the effective `extensions` setting,
 * installed npm/link plugins, Claude marketplace plugin agents (project scope
 * before user), then bundled.
 * @param cwd - Current working directory for project agent discovery
 * @param home - Home directory for user and marketplace discovery
 * @param extensionRoots - Session-local extension roots (explicit + mode + configured)
 * @param options - Explicit `disabledExtensions` override; defaults to the bound settings
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
	options?: DiscoverAgentsOptions,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project", provider: "native" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user", provider: "native" });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level, provider: "omp-plugins" });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders and opt-in).
	// User-scope roots whose origin is not the foreign ~/.claude/plugins tree (omp's own
	// installs and `--plugin-dir` roots) survive the claude-plugins opt-in gate, mirroring
	// isSourceEnabled in extensibility/skills.ts (#10743). Without this, `--plugin-dir` and
	// omp-installed agents are dropped at user scope whenever the Claude source is disabled.
	const claudePluginsUserEnabled = isUserSourceEnabled("claude-plugins") || isUserSourceEnabled("claude");
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const filteredPluginRoots = pluginRoots.filter(
		r => r.scope === "project" || claudePluginsUserEnabled || r.origin !== "claude",
	);
	const sortedPluginRoots = [...filteredPluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	const pluginModelDrops = await Promise.all(
		// The `model:` dialect follows the plugin's declared manifest, not the
		// registry that supplied it: foreign Claude roots (origin "claude") always
		// use Claude aliases, and an omp-installed or --plugin-dir root can still
		// ship a `.claude-plugin` package. Claude-dialect frontmatter is dropped so
		// its aliases are not misread as OMP selectors (#7966); OMP-native and
		// Agent-Plugins-standard plugin agents keep their selectors (#12028).
		sortedPluginRoots.map(
			async plugin => plugin.origin === "claude" || (await pluginUsesClaudeModelDialect(plugin.path)),
		),
	);
	sortedPluginRoots.forEach((plugin, index) => {
		orderedDirs.push({
			dir: path.join(plugin.path, "agents"),
			source: plugin.scope === "project" ? "project" : "user",
			provider: "claude-plugins",
			ignoreModel: pluginModelDrops[index],
		});
	});

	// `agent:<name>` in `disabledExtensions` hides a discovered agent before dedup, so a disabled
	// agent never shadows a bundled or lower-precedence one of the same name. Bundled agents are
	// exempt: the task tool and its prompts depend on them, and `task.disabledAgents` turns those off.
	const disabledIds = new Set(disabledAgentExtensionIds(options?.disabledExtensions));
	const seen = new Set<string>();
	const seenDisabled = new Set<string>();
	const disabledAgents: AgentDefinition[] = [];
	const loadedAgents = (await Promise.all(orderedDirs.map(loadAgentsFromDir))).flat().filter(agent => {
		if (disabledIds.has(`agent:${agent.name}`)) {
			if (!seenDisabled.has(agent.name)) {
				seenDisabled.add(agent.name);
				disabledAgents.push(agent);
			}
			return false;
		}
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return {
		agents: [...loadedAgents, ...bundledAgents],
		disabledAgents,
		projectAgentsDir,
		searchedDirs: orderedDirs.map(entry => entry.dir),
	};
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
