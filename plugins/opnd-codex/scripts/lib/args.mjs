export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * #333 — Parse review/adversarial-review argv without leaking focus-text tokens.
 *
 * When Claude Code forwards `/opnd-codex:review $ARGUMENTS` the entire user
 * input arrives as a single raw string.  normalizeArgv() splits it with
 * splitRawArgumentString() and then parseArgs() consumes the resulting tokens
 * left-to-right.  Any "--FLAG VALUE" substrings inside the focus text are
 * indistinguishable from real CLI flags and get silently consumed as options.
 *
 * This helper parses only the known review options greedily from the front of
 * the token list and treats everything after the first unrecognised token as a
 * single joined focus string.  Unknown flag-shaped tokens (e.g. --scope-hint)
 * that appear *before* the focus text are also collected into the focus string
 * so no information is lost.
 *
 * @param {string[]} argv     Raw argv passed to handleReviewCommand.
 * @param {string[]} valueOptions   Option names that consume the next token.
 * @param {string[]} booleanOptions Option names that are boolean flags.
 * @param {Record<string,string>} aliasMap Short → long alias mapping.
 * @returns {{ options: Record<string,unknown>, focusTokens: string[] }}
 */
export function parseReviewArgv(argv, { valueOptions = [], booleanOptions = [], aliasMap = {} } = {}) {
  const valueSet = new Set(valueOptions);
  const boolSet = new Set(booleanOptions);
  const tokens = splitRawArgumentString(argv.length === 1 && argv[0] ? argv[0] : argv.join(" "));
  const options = {};
  let focusStart = tokens.length; // index of first token that belongs to focus

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "--") {
      focusStart = i + 1;
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      // First positional = start of focus text.
      focusStart = i;
      break;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (boolSet.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueSet.has(key)) {
        const nextValue = inlineValue ?? tokens[i + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          i += 1;
        }
        continue;
      }

      // Unknown flag — treat everything from here as focus text.
      focusStart = i;
      break;
    }

    // Short option
    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (boolSet.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueSet.has(key)) {
      const nextValue = tokens[i + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      i += 1;
      continue;
    }

    // Unknown short option — start of focus text.
    focusStart = i;
    break;
  }

  return { options, focusTokens: tokens.slice(focusStart) };
}
