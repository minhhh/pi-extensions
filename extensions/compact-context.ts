/**
 * Compact Context Tool.
 *
 * Gives the model its own way to compact, without waiting for the user to type
 * /compact. The call goes through the same `session.compact()` path as the
 * slash command, so the model, settings, summary format, and thresholds all
 * match.
 *
 * `ctx.compact()` aborts the current run before it summarizes, so the tool
 * result never reaches the model. The turn ends and work continues from the
 * compacted context. Success and failure are reported with the same wording
 * the harness uses for a manual compaction.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const compactTool = defineTool({
	name: "compact_context",
	label: "Compact Context",
	description:
		"Summarize the conversation so far and drop older messages. Use when the context is getting long or the work has moved to a new phase.",
	parameters: Type.Object({
		instructions: Type.Optional(Type.String({ description: "What the summary should keep or emphasize" })),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		ctx.compact({
			customInstructions: params.instructions,
			onComplete: (result) => {
				const after = result.estimatedTokensAfter;
				const detail =
					after === undefined
						? `${result.tokensBefore.toLocaleString()} tokens before compaction`
						: `${result.tokensBefore.toLocaleString()} -> ${after.toLocaleString()} tokens`;
				ctx.ui.notify(`Compacted. ${detail}.`, "info");
			},
			// The harness shows a failed manual /compact with the raw error message.
			// Cover the same cases here, including "Compaction cancelled" and
			// "No model selected...".
			onError: (error) => {
				ctx.ui.notify(error.message, "error");
			},
		});

		return {
			content: [
				{
					type: "text",
					text: "Compaction started. This turn ends; the next request continues from the summary.",
				},
			],
			details: undefined,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(compactTool);
}
