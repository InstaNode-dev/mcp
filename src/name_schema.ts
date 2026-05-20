/**
 * Shared resource-name validation, mirrored from the api's contract.
 *
 * The agent API enforces:
 *   pattern:   ^[A-Za-z0-9][A-Za-z0-9 _-]*$
 *   minLength: 1
 *   maxLength: 64
 *
 * See `api/internal/handlers/provision_helper.go::nameValidationPattern` for
 * the canonical regex and `api/internal/handlers/openapi.go` for the OpenAPI
 * surface (every `/<resource>/new` body schema uses this same shape).
 *
 * BugBash B16 F2 (regression of task #173): the MCP server previously only
 * validated length on the `name` field, so bad input (e.g. "  foo", "foo!",
 * "foo/bar", empty after trim) round-tripped to the API and surfaced as
 * 400 invalid_name — a confusing two-step error the agent then had to parse.
 * Mirroring the regex here lets the MCP reject the bad input at the Zod
 * boundary with a precise message, before the network call.
 *
 * Single source: every create_* tool — and any other surface that takes a
 * `name` — imports `nameSchema` from this module. Drift between the API's
 * regex and the MCP's regex is now a compile-time / lint problem, not a
 * runtime "the agent saw a 400 it could not explain" problem.
 */

import { z } from "zod";

/**
 * The canonical name regex enforced by the agent API. Exported so tests can
 * pin the exact pattern and a future regex bump in api/ surfaces here as a
 * failing test rather than a silent drift.
 */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/**
 * Standard description rendered into every tool's input schema. Mirrors the
 * api's OpenAPI description verbatim so the agent's tools/list output and the
 * api's openapi.json say the same thing.
 */
export const NAME_DESCRIPTION =
  "Human-readable label for this resource (1-64 chars; must start with a letter or digit, then letters/digits/spaces/underscores/hyphens). Example: 'prospector-agent', 'stripe-sandbox'.";

/**
 * Zod schema enforcing the API's name contract. Use as `nameSchema` (required)
 * or `nameSchema.optional()` (e.g. the `get_api_token` tool's optional label).
 */
export const nameSchema = z
  .string()
  .min(1, { message: "name must be at least 1 character" })
  .max(64, { message: "name must be at most 64 characters" })
  .regex(NAME_PATTERN, {
    message:
      "name must start with a letter or digit, then letters/digits/spaces/underscores/hyphens (matches /^[A-Za-z0-9][A-Za-z0-9 _-]*$/)",
  })
  .describe(NAME_DESCRIPTION);
