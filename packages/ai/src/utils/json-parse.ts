import { parse as partialParse } from "partial-json";

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
						result += "\\u" + code.toString(16).padStart(4, "0");
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
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// Sanitize raw control characters inside string literals before retrying.
		// LLMs sometimes emit real newlines/tabs instead of \n/\t in tool-call
		// argument JSON strings (e.g. multi-line code in edit oldText/newText).
		const sanitized = sanitizeJsonControlChars(partialJson);
		if (sanitized !== partialJson) {
			try {
				return JSON.parse(sanitized) as T;
			} catch {
				// fall through to partial-json
			}
		}

		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(sanitized);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}
