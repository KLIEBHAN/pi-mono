/**
 * Terminal-Bench Extension
 *
 * Optimizes pi for Terminal-Bench 2.0 benchmark performance by porting
 * key strategies from the Meta-Harness agent:
 *
 * 1. **Environment Bootstrapping**: Gathers a sandbox snapshot (files,
 *    languages, package managers, memory) before the first LLM call and
 *    injects it into the system prompt. Saves 2-5 early exploration turns.
 *
 * 2. **Completion Verification**: When the agent signals it is done, injects
 *    a self-verification checklist as a follow-up to reduce false completions.
 *
 * 3. **Prompt Optimizations**: Appends Terminal-Bench-specific instructions
 *    to the system prompt (no human help, programmatic multimedia handling,
 *    minimal state changes, cleanup).
 *
 * The extension is gated behind the --terminal-bench flag and does nothing
 * unless that flag is provided. This avoids side effects during normal usage.
 *
 * Usage:
 *   pi -e ./terminal-bench.ts --terminal-bench
 *
 * Works best with:
 *   pi -e ./terminal-bench.ts --terminal-bench --thinking high
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Prompt additions
// ---------------------------------------------------------------------------

const TERMINAL_BENCH_GUIDELINES = `
## Terminal-Bench Rules

- You must complete the entire task WITHOUT any human intervention. Do not ask
  clarifying questions or wait for human input. Make reasonable assumptions and
  proceed.
- You do NOT have eyes or ears. For multimedia files (images, audio, video),
  use programmatic or CLI tools to inspect them (e.g. file, identify, ffprobe,
  exiftool, python scripts). Never guess content from filenames alone.
- Before finishing, verify minimal state changes: identify the absolute minimum
  set of files that must be created or modified to satisfy the task. Beyond
  those required files, the system state must remain identical to its original
  state. Do not leave behind extra files, modified configurations, temporary
  artifacts, or side effects that were not explicitly requested.
- Prefer short, targeted commands. Avoid long-running blocking commands.
  If a command might take a while, check intermediate output instead of
  waiting indefinitely.
- When you believe the task is complete, re-read the original task description
  and verify your solution meets ALL requirements before confirming.
`.trim();

const COMPLETION_CHECKLIST = (taskHint: string, terminalState: string) =>
	`
VERIFICATION REQUIRED: You signaled that you are finished. Before moving on,
review this checklist carefully.

Original task:
${taskHint}

Last terminal output:
${terminalState}

Checklist — mark each as DONE or TODO:
- Does your solution meet ALL requirements in the original task? [TODO/DONE]
- Does your solution account for variable values (numeric values, array sizes,
  file contents, configuration parameters)? [TODO/DONE]
- Have you cleaned up temporary files, scripts, or side effects not required
  by the task? [TODO/DONE]
- Verified from the perspective of:
  - A test engineer? [TODO/DONE]
  - A QA engineer? [TODO/DONE]
  - The user who requested this task? [TODO/DONE]

If everything is DONE, proceed. If any item is TODO, fix it first.
`.trim();

// ---------------------------------------------------------------------------
// Environment bootstrapping
// ---------------------------------------------------------------------------

// Uses semicolons so a failing command does not abort subsequent sections.
// Each section marker is unconditional; the actual probes use || fallbacks.
const BOOTSTRAP_COMMAND = [
	"echo '@@PWD@@'; pwd",
	"echo '@@LS@@'; ls -la 2>/dev/null || true",
	"echo '@@LANG@@'",
	"(python3 --version 2>&1 || echo 'python3: not found')",
	"(gcc --version 2>&1 | head -1 || echo 'gcc: not found')",
	"(g++ --version 2>&1 | head -1 || echo 'g++: not found')",
	"(node --version 2>&1 || echo 'node: not found')",
	"(java -version 2>&1 | head -1 || echo 'java: not found')",
	"(rustc --version 2>&1 || echo 'rustc: not found')",
	"(go version 2>&1 || echo 'go: not found')",
	"echo '@@PKG@@'",
	"(pip3 --version 2>&1 || echo 'pip3: not found')",
	"(pip --version 2>&1 || echo 'pip: not found')",
	"(apt-get --version 2>&1 | head -1 || echo 'apt-get: not found')",
	"(npm --version 2>&1 || echo 'npm: not found')",
	"(cargo --version 2>&1 || echo 'cargo: not found')",
	"echo '@@MEM@@'; free -h 2>/dev/null | head -2 || true",
].join("; ");

interface BootstrapSections {
	[key: string]: string;
}

function parseBootstrapOutput(stdout: string): BootstrapSections {
	const sections: BootstrapSections = {};
	let currentKey: string | null = null;
	const currentLines: string[] = [];

	for (const line of stdout.split("\n")) {
		if (line.startsWith("@@") && line.endsWith("@@")) {
			if (currentKey) {
				sections[currentKey] = currentLines.join("\n");
				currentLines.length = 0;
			}
			currentKey = line.replace(/^@@|@@$/g, "");
		} else {
			currentLines.push(line);
		}
	}
	if (currentKey) {
		sections[currentKey] = currentLines.join("\n");
	}
	return sections;
}

function formatSnapshot(sections: BootstrapSections): string {
	const parts: string[] = [];

	// Intentionally skip PWD — pi's system prompt already includes
	// "Current working directory: ..." so repeating it is redundant.

	if (sections.LS) {
		const lsLines = sections.LS.trim().split("\n");
		if (lsLines.length <= 1 || (lsLines.length === 2 && lsLines[0].includes("total 0"))) {
			parts.push("Directory contents: (empty)");
		} else if (lsLines.length > 30) {
			parts.push(
				`Directory contents (${lsLines.length} entries):\n${lsLines.slice(0, 25).join("\n")}\n... (${lsLines.length - 25} more files)`,
			);
		} else {
			parts.push(`Directory contents:\n${sections.LS.trim()}`);
		}
	}

	if (sections.LANG) {
		const langLines = sections.LANG.trim()
			.split("\n")
			.filter((l) => l.trim());
		if (langLines.length > 0) {
			parts.push(`Available languages/tools: ${langLines.join("; ")}`);
		}
	}

	if (sections.PKG) {
		const pkgLines = sections.PKG.trim()
			.split("\n")
			.filter((l) => l.trim());
		if (pkgLines.length > 0) {
			parts.push(`Package managers: ${pkgLines.join("; ")}`);
		}
	}

	if (sections.MEM) {
		const mem = sections.MEM.trim();
		if (mem) {
			parts.push(`Memory: ${mem}`);
		}
	}

	if (parts.length === 0) {
		return "";
	}

	return `[Environment Snapshot]\n${parts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

/**
 * Checks whether the assistant message is a confident, standalone statement
 * that the task is finished. Returns false for tentative, conditional, or
 * questioning uses ("check if the task is complete", "once the task is done").
 */
function isCompletionStatement(text: string): boolean {
	const lower = text.toLowerCase();

	// Phrases that indicate confident completion
	const patterns = [
		/\b(?:the\s+)?task\s+is\s+(?:now\s+)?complete\b/,
		/\b(?:the\s+)?task\s+is\s+(?:now\s+)?done\b/,
		/\b(?:the\s+)?task\s+has\s+been\s+completed\b/,
		/\bi(?:'ve|'ve|\s+have)\s+completed\s+the\s+task\b/,
		/\b(?:the\s+)?task\s+is\s+(?:now\s+)?finished\b/,
		/\b(?:the\s+)?solution\s+is\s+(?:now\s+)?complete\b/,
		/\ball\s+requirements\s+(?:have\s+been|are(?:\s+now)?)\s+met\b/,
	];

	// Reject if preceded by words that make it conditional/interrogative
	const negatingPrefixes = [
		"check if",
		"check whether",
		"verify if",
		"verify whether",
		"verify that",
		"ensure that",
		"ensure the",
		"confirm that",
		"confirm whether",
		"once the",
		"when the",
		"if the",
		"whether the",
		"before the",
		"until the",
		"not yet",
	];

	for (const pattern of patterns) {
		const match = pattern.exec(lower);
		if (!match) continue;

		// Check 40 chars before the match for negating context
		const preContext = lower.slice(Math.max(0, match.index - 40), match.index);
		const isNegated = negatingPrefixes.some((prefix) => preContext.includes(prefix));
		if (!isNegated) {
			return true;
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Gate: do nothing unless --terminal-bench is provided
	pi.registerFlag("terminal-bench", {
		description: "Enable Terminal-Bench optimizations",
		type: "boolean",
		default: false,
	});

	let enabled = false;
	let envSnapshot = "";
	let completionPending = false;
	let lastBashOutput = "";

	// Gather environment snapshot on session start
	pi.on("session_start", async (_event, _ctx) => {
		enabled = pi.getFlag("terminal-bench") === true;
		if (!enabled) return;

		envSnapshot = "";
		completionPending = false;
		lastBashOutput = "";

		try {
			const result = await pi.exec("bash", ["-c", BOOTSTRAP_COMMAND], { timeout: 15000 });
			if (result.code === 0 && result.stdout) {
				const sections = parseBootstrapOutput(result.stdout);
				envSnapshot = formatSnapshot(sections);
			}
		} catch {
			// Silent failure — don't break the agent
		}
	});

	// Inject guidelines and snapshot into system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!enabled) return;

		let systemPrompt = event.systemPrompt;

		systemPrompt += `\n\n${TERMINAL_BENCH_GUIDELINES}`;

		if (envSnapshot) {
			systemPrompt += `\n\n${envSnapshot}`;
		}

		return { systemPrompt };
	});

	// Track last bash output for completion checklist
	pi.on("tool_result", async (event, _ctx) => {
		if (!enabled) return;

		if (event.toolName === "bash" && !event.isError) {
			const textContent = event.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { type: "text"; text: string }).text)
				.join("\n");
			if (textContent) {
				lastBashOutput = textContent.slice(-2000);
			}
		}
	});

	// Detect completion signals and inject verification
	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		const content = event.message.content;
		if (!Array.isArray(content)) return;

		const textBlocks = content
			.filter(
				(b): b is { type: "text"; text: string } =>
					typeof b === "object" && b !== null && "type" in b && b.type === "text",
			)
			.map((b) => b.text)
			.join("\n");

		if (!textBlocks) return;

		const isCompletion = isCompletionStatement(textBlocks);

		if (isCompletion && !completionPending) {
			completionPending = true;

			// Get task hint from first user message
			const entries = ctx.sessionManager.getBranch();
			let taskHint = "(not available in context)";
			for (const entry of entries) {
				if (entry.type === "message" && entry.message.role === "user") {
					const msg = entry.message;
					if (typeof msg.content === "string") {
						taskHint = msg.content.slice(0, 2000);
					} else if (Array.isArray(msg.content)) {
						const texts = msg.content
							.filter(
								(b): b is { type: "text"; text: string } =>
									typeof b === "object" && b !== null && "type" in b && b.type === "text",
							)
							.map((b) => b.text);
						taskHint = texts.join("\n").slice(0, 2000);
					}
					break;
				}
			}

			const checklist = COMPLETION_CHECKLIST(taskHint, lastBashOutput.slice(-1000) || "(no recent output)");

			pi.sendUserMessage(checklist, { deliverAs: "followUp" });
		} else if (!isCompletion) {
			// Reset so a later genuine completion triggers verification again
			completionPending = false;
		}
	});
}
