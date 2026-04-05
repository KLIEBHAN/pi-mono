/**
 * Terminal-Bench Extension
 *
 * Optimizes pi for Terminal-Bench 2.0 benchmark performance by porting
 * key strategies from the Meta-Harness agent:
 *
 * 1. **Environment Bootstrapping**: Gathers a sandbox snapshot (pwd, files,
 *    languages, package managers, memory) before the first LLM call and
 *    injects it into the system prompt. Saves 2-5 early exploration turns.
 *
 * 2. **Completion Verification**: Intercepts "I'm done" signals and forces
 *    a self-verification checklist before the agent can finish, reducing
 *    false completions.
 *
 * 3. **Prompt Optimizations**: Appends Terminal-Bench-specific instructions
 *    to the system prompt (no human help, programmatic multimedia handling,
 *    minimal state changes, cleanup).
 *
 * Usage:
 *   pi -e ./terminal-bench.ts
 *
 * Works best with:
 *   pi -e ./terminal-bench.ts --thinking high
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
You indicated the task is complete. Before confirming, review this checklist:

Original task (if available):
${taskHint}

Current terminal state (last output):
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

If everything is DONE, proceed with your work. If any item is TODO, fix it
first and then continue.
`.trim();

// ---------------------------------------------------------------------------
// Environment bootstrapping
// ---------------------------------------------------------------------------

const BOOTSTRAP_COMMAND = [
	"echo '@@PWD@@' && pwd",
	"echo '@@LS@@' && ls -la 2>/dev/null",
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
	"echo '@@MEM@@' && free -h 2>/dev/null | head -2 || true",
].join(" && ");

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

	if (sections.PWD) {
		parts.push(`Working directory: ${sections.PWD.trim()}`);
	}

	if (sections.LS) {
		const lsLines = sections.LS.trim().split("\n");
		if (lsLines.length <= 1 || (lsLines.length === 2 && lsLines[0].includes("total 0"))) {
			parts.push("Directory contents: (empty)");
		} else if (lsLines.length > 30) {
			parts.push(
				`Directory contents (${lsLines.length} entries):\n` +
					lsLines.slice(0, 25).join("\n") +
					`\n... (${lsLines.length - 25} more files)`,
			);
		} else {
			parts.push(`Directory contents:\n${sections.LS.trim()}`);
		}
	}

	if (sections.LANG) {
		const langLines = sections.LANG.trim()
			.split("\n")
			.filter((l) => l.trim());
		parts.push(`Available languages/tools: ${langLines.join("; ")}`);
	}

	if (sections.PKG) {
		const pkgLines = sections.PKG.trim()
			.split("\n")
			.filter((l) => l.trim());
		parts.push(`Package managers: ${pkgLines.join("; ")}`);
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
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let envSnapshot = "";
	let completionPending = false;
	let lastBashOutput = "";

	// Gather environment snapshot on session start
	pi.on("session_start", async (_event, _ctx) => {
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
		let systemPrompt = event.systemPrompt;

		// Append terminal-bench guidelines
		systemPrompt += `\n\n${TERMINAL_BENCH_GUIDELINES}`;

		// Append environment snapshot if available
		if (envSnapshot) {
			systemPrompt += `\n\n${envSnapshot}`;
		}

		return { systemPrompt };
	});

	// Track last bash output for completion checklist
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName === "bash" && !event.isError) {
			const textContent = event.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { type: "text"; text: string }).text)
				.join("\n");
			if (textContent) {
				// Keep last 2000 chars for context
				lastBashOutput = textContent.slice(-2000);
			}
		}
	});

	// Detect completion signals and inject verification
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const content = event.message.content;
		if (!content) return;

		// Check if assistant is signaling completion
		const textBlocks = (Array.isArray(content) ? content : [])
			.filter(
				(b): b is { type: "text"; text: string } =>
					typeof b === "object" && b !== null && "type" in b && b.type === "text",
			)
			.map((b) => b.text)
			.join("\n");

		const completionSignals = [
			"task is complete",
			"task is done",
			"task has been completed",
			"i've completed the task",
			"i have completed the task",
			"the task is finished",
			"all requirements have been met",
			"all requirements are met",
			"solution is complete",
			"i'm done",
			"i am done",
		];

		const lowerText = textBlocks.toLowerCase();
		const isCompletionSignal = completionSignals.some((s) => lowerText.includes(s));

		if (isCompletionSignal && !completionPending) {
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
		} else if (!isCompletionSignal) {
			// Reset if the model is continuing work
			completionPending = false;
		}
	});
}
