import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.js";

describe("parseStreamingJson", () => {
	it("parses valid complete JSON", () => {
		const result = parseStreamingJson<{ a: number }>('{"a": 1}');
		expect(result).toEqual({ a: 1 });
	});

	it("returns empty object for empty input", () => {
		expect(parseStreamingJson("")).toEqual({});
		expect(parseStreamingJson(undefined)).toEqual({});
		expect(parseStreamingJson("   ")).toEqual({});
	});

	it("handles partial/incomplete JSON via partial-json fallback", () => {
		const result = parseStreamingJson<{ name: string }>('{"name": "hel');
		expect(result).toHaveProperty("name");
	});

	it("returns empty object for completely broken input", () => {
		expect(parseStreamingJson("not json at all {{")).toEqual({});
	});

	describe("control character sanitization", () => {
		it("handles raw newlines inside JSON string values", () => {
			const raw = '{"oldText": "line one\nline two\nline three", "newText": "replaced"}';
			const result = parseStreamingJson<{ oldText: string; newText: string }>(raw);
			expect(result.oldText).toBe("line one\nline two\nline three");
			expect(result.newText).toBe("replaced");
		});

		it("handles raw tabs inside JSON string values", () => {
			const raw = '{"code": "\tindented"}';
			const result = parseStreamingJson<{ code: string }>(raw);
			expect(result.code).toBe("\tindented");
		});

		it("handles raw carriage returns inside JSON string values", () => {
			const raw = '{"text": "line\r\nbreak"}';
			const result = parseStreamingJson<{ text: string }>(raw);
			expect(result.text).toBe("line\r\nbreak");
		});

		it("preserves already-escaped sequences", () => {
			const raw = '{"text": "already\\nescaped"}';
			const result = parseStreamingJson<{ text: string }>(raw);
			expect(result.text).toBe("already\nescaped");
		});

		it("handles edit tool arguments with multi-line code", () => {
			// Realistic reproduction: LLM generates edit call with real newlines
			const raw =
				'{"path": "/some/file.ts", "edits": [{"oldText": "\t\t// Discover tmux\n\t\ttry {\n\t\t\tconst result", "newText": "replaced"}]}';
			const result = parseStreamingJson<{
				path: string;
				edits: Array<{ oldText: string; newText: string }>;
			}>(raw);
			expect(result.path).toBe("/some/file.ts");
			expect(result.edits).toHaveLength(1);
			expect(result.edits[0].oldText).toContain("Discover tmux");
			expect(result.edits[0].oldText).toContain("\n");
			expect(result.edits[0].newText).toBe("replaced");
		});

		it("does not corrupt structural whitespace between JSON tokens", () => {
			const raw = '{\n  "a": 1,\n  "b": "has\nnewline"\n}';
			const result = parseStreamingJson<{ a: number; b: string }>(raw);
			expect(result.a).toBe(1);
			expect(result.b).toBe("has\nnewline");
		});

		it("handles mixed escaped and raw control characters", () => {
			const raw = '{"a": "escaped\\nnewline", "b": "raw\nnewline"}';
			const result = parseStreamingJson<{ a: string; b: string }>(raw);
			expect(result.a).toBe("escaped\nnewline");
			expect(result.b).toBe("raw\nnewline");
		});
	});
});
