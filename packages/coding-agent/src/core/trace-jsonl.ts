import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSessionEvent } from "./agent-session.js";
import type {
	AgentSessionRuntime,
	AgentSessionRuntimeSessionChangeEvent,
	AgentSessionRuntimeSessionChangeListener,
} from "./agent-session-runtime.js";

const TRACE_VERSION = 1;
const MAX_TRACE_DEPTH = 8;
const MAX_TRACE_STRING_CHARS = 20_000;

type TraceStartRecord = {
	type: "trace_start";
	traceVersion: number;
	timestamp: string;
	pid: number;
	version: string;
	cwd: string;
	mode: "interactive" | "print" | "json" | "rpc";
};

type SessionChangeRecord = {
	type: "session_change";
	timestamp: string;
	reason: AgentSessionRuntimeSessionChangeEvent["reason"];
	cwd: string;
	sessionFile?: string;
	previousSessionFile?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
};

type SessionEventRecord = {
	type: "session_event";
	timestamp: string;
	cwd: string;
	sessionFile?: string;
	eventType: string;
	event: unknown;
};

function nowIso(): string {
	return new Date().toISOString();
}

function truncateString(value: string): string {
	if (value.length <= MAX_TRACE_STRING_CHARS) {
		return value;
	}
	const omitted = value.length - MAX_TRACE_STRING_CHARS;
	return `${value.slice(0, MAX_TRACE_STRING_CHARS)}… [truncated ${omitted} chars]`;
}

function sanitizeForTrace(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
	if (value == null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return truncateString(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "function") {
		return `[Function ${value.name || "anonymous"}]`;
	}
	if (depth >= MAX_TRACE_DEPTH) {
		return "[MaxDepth]";
	}

	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (value instanceof Map) {
		const typedSeen = seen ?? new WeakSet<object>();
		if (typedSeen.has(value)) {
			return "[Circular]";
		}
		typedSeen.add(value);
		const result = {
			type: "Map",
			entries: [...value.entries()].map(([k, v]) => [
				sanitizeForTrace(k, depth + 1, typedSeen),
				sanitizeForTrace(v, depth + 1, typedSeen),
			]),
		};
		typedSeen.delete(value);
		return result;
	}
	if (value instanceof Set) {
		const typedSeen = seen ?? new WeakSet<object>();
		if (typedSeen.has(value)) {
			return "[Circular]";
		}
		typedSeen.add(value);
		const result = {
			type: "Set",
			values: [...value.values()].map((item) => sanitizeForTrace(item, depth + 1, typedSeen)),
		};
		typedSeen.delete(value);
		return result;
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: value.constructor.name,
			byteLength: value.byteLength,
		};
	}
	if (value instanceof ArrayBuffer) {
		return {
			type: "ArrayBuffer",
			byteLength: value.byteLength,
		};
	}
	if (Array.isArray(value)) {
		const typedSeen = seen ?? new WeakSet<object>();
		if (typedSeen.has(value)) {
			return "[Circular]";
		}
		typedSeen.add(value);
		const result = value.map((item) => sanitizeForTrace(item, depth + 1, typedSeen));
		typedSeen.delete(value);
		return result;
	}
	if (typeof value === "object") {
		const typedSeen = seen ?? new WeakSet<object>();
		if (typedSeen.has(value)) {
			return "[Circular]";
		}
		typedSeen.add(value);
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = sanitizeForTrace(entry, depth + 1, typedSeen);
		}
		typedSeen.delete(value);
		return result;
	}

	return String(value);
}

function eventTypeOf(event: AgentSessionEvent): string {
	return typeof event === "object" && event !== null && "type" in event && typeof event.type === "string"
		? event.type
		: "unknown";
}

export class JsonlTraceLogger {
	private unsubscribeRuntime: (() => void) | undefined;
	private unsubscribeSession: (() => void) | undefined;
	private disabled = false;

	constructor(
		private readonly filePath: string,
		metadata: {
			cwd: string;
			mode: "interactive" | "print" | "json" | "rpc";
			pid: number;
			version: string;
		},
	) {
		mkdirSync(dirname(filePath), { recursive: true });
		this.writeRecord({
			type: "trace_start",
			traceVersion: TRACE_VERSION,
			timestamp: nowIso(),
			pid: metadata.pid,
			version: metadata.version,
			cwd: metadata.cwd,
			mode: metadata.mode,
		} satisfies TraceStartRecord);
	}

	attach(runtime: AgentSessionRuntime): () => void {
		const onSessionChange: AgentSessionRuntimeSessionChangeListener = (event) => {
			this.unsubscribeSession?.();
			this.writeRecord(this.createSessionChangeRecord(event));
			this.unsubscribeSession = event.session.subscribe((sessionEvent) => {
				this.writeRecord(this.createSessionEventRecord(event, sessionEvent));
			});
		};

		this.unsubscribeRuntime = runtime.subscribeSessionChanges(onSessionChange, { emitCurrent: true });
		return () => this.dispose();
	}

	dispose(): void {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.unsubscribeRuntime?.();
		this.unsubscribeRuntime = undefined;
	}

	private createSessionChangeRecord(event: AgentSessionRuntimeSessionChangeEvent): SessionChangeRecord {
		const model = event.session.model;
		return {
			type: "session_change",
			timestamp: nowIso(),
			reason: event.reason,
			cwd: event.services.cwd,
			sessionFile: event.session.sessionFile,
			previousSessionFile: event.previousSessionFile,
			model: model ? { provider: model.provider, id: model.id } : undefined,
			thinkingLevel: event.session.thinkingLevel,
		};
	}

	private createSessionEventRecord(
		sessionChange: AgentSessionRuntimeSessionChangeEvent,
		event: AgentSessionEvent,
	): SessionEventRecord {
		return {
			type: "session_event",
			timestamp: nowIso(),
			cwd: sessionChange.services.cwd,
			sessionFile: sessionChange.session.sessionFile,
			eventType: eventTypeOf(event),
			event: sanitizeForTrace(event),
		};
	}

	private writeRecord(record: TraceStartRecord | SessionChangeRecord | SessionEventRecord): void {
		if (this.disabled) {
			return;
		}
		try {
			appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			this.disabled = true;
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Trace logging disabled for ${this.filePath}: ${message}\n`);
		}
	}
}
