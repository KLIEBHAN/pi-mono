import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Escape raw control characters (0x00–0x1F) that appear inside JSON string
 * literals. LLMs sometimes emit real newlines/tabs inside quoted values
 * instead of the required `\n`/`\t` escape sequences, which makes
 * `JSON.parse` reject the payload with "Bad control character in string
 * literal". This function walks the JSON text, tracks whether we are inside
 * a quoted string, and replaces offending bytes with their JSON escape form.
 *
 * Structural whitespace (newlines/tabs *between* tokens) is left untouched.
 */
function sanitizeJsonControlChars(json: string): string {
	// Fast path: if there are no raw control characters at all, return as-is.
	if (!/[\x00-\x1f]/.test(json)) {
		return json;
	}

	let result = "";
	let inString = false;

	for (let i = 0; i < json.length; i++) {
		const code = json.charCodeAt(i);

		if (inString) {
			// Backslash escape – keep the pair verbatim.
			if (code === 0x5c /* \ */ && i + 1 < json.length) {
				result += json[i] + json[i + 1];
				i++;
				continue;
			}

			// End of string.
			if (code === 0x22 /* " */) {
				inString = false;
				result += json[i];
				continue;
			}

			// Control character inside a string literal – must be escaped.
			if (code < 0x20) {
				switch (code) {
					case 0x08:
						result += "\\b";
						break;
					case 0x09:
						result += "\\t";
						break;
					case 0x0a:
						result += "\\n";
						break;
					case 0x0c:
						result += "\\f";
						break;
					case 0x0d:
						result += "\\r";
						break;
					default:
						result += `\\u${code.toString(16).padStart(4, "0")}`;
						break;
				}
				continue;
			}

			result += json[i];
		} else {
			if (code === 0x22 /* " */) {
				inString = true;
			}
			result += json[i];
		}
	}

	return result;
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T extends JsonObject = JsonObject>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	const parseObject = (json: string): T => {
		const parsed = parseJsonWithRepair<unknown>(json);
		return (isJsonObject(parsed) ? parsed : {}) as T;
	};

	try {
		return parseObject(partialJson);
	} catch {
		// Sanitize raw control characters inside string literals before retrying.
		// LLMs sometimes emit real newlines/tabs instead of \n/\t in tool-call
		// argument JSON strings (e.g. multi-line code in edit oldText/newText).
		const sanitized = sanitizeJsonControlChars(partialJson);
		if (sanitized !== partialJson) {
			try {
				return parseObject(sanitized);
			} catch {
				// fall through to partial-json
			}
		}

		// Try partial-json for incomplete JSON.
		try {
			const result = partialParse(sanitized);
			return (isJsonObject(result) ? result : {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (isJsonObject(result) ? result : {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
