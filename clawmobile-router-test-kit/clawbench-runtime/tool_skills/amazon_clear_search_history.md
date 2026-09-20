---
name: amazon-clear-search-history
description: "Clear the visible recent search-history suggestions in the Amazon Shopping app by opening search and tapping the X delete controls for each shown history row."
clawmobile_generated: true
clawmobile_schema: clawmobile.skill.v2
feedback_supported: true
feedback_tool: clawmobile_skill_record_feedback
status_tool: clawmobile_skill_status
---

# clear_amazon_visible_search_history

Clear the visible recent search-history suggestions in the Amazon Shopping app by opening search and tapping the X delete controls for each shown history row.

## Skill Review

After generating or updating this skill, briefly explain it to the user before treating it as settled.
- What it does: summarize the intent in one sentence.
- Parameters: name the required values the user can change.
- Steps: describe the procedure in plain language, without raw implementation detail.
- Confidence: mention any important uncertainty, regrounding point, or unsupported parameter.
- Improvement path: if the user says the behavior is wrong or incomplete, record another demonstration of the same task and update this skill from that trace.

## Applicability

This skill separates procedure applicability from anchor applicability.
If the intent matches but an anchor moved, prefer `applicable_with_regrounding` over immediate rejection.
For recorded-first anchors, visual uncertainty alone should not replace the recorded coordinate before the first safe attempt.

- If intent matches, required parameters are available, and current screen satisfies entry_states plus anchor valid_when conditions, then `applicable`.
- If intent matches but one or more anchors must be relocated while the reusable procedure still fits, then `applicable_with_regrounding; for recorded-first anchors, attempt the recorded anchor before relocation unless the current state is clearly unsafe`.
- If intent matches but a requested parameter is listed in intent.not_covered_parameters, then `applicable_with_regrounding only when another skill/tool can ground that parameter; otherwise not_applicable`.
- If app/package, task intent, or required procedure does not match the current user request, then `not_applicable`.

## Parameters


## Procedure

1. tap search_bar
   - Anchor: `search_bar`
   - Tool: use `android_tap` after the anchor is accepted or regrounded.
   - Grounding: Use search_bar when its valid_when condition holds; otherwise keep the procedure applicable_with_regrounding.
2. tap first_history_delete_x
   - Anchor: `first_history_delete_x`
   - Tool: use `android_tap` after the anchor is accepted or regrounded.
   - Grounding: Use first_history_delete_x when its valid_when condition holds; otherwise keep the procedure applicable_with_regrounding.
3. tap next_history_delete_x
   - Anchor: `next_history_delete_x`
   - Tool: use `android_tap` after the anchor is accepted or regrounded.
   - Grounding: Use next_history_delete_x when its valid_when condition holds; otherwise keep the procedure applicable_with_regrounding.
4. tap final_history_delete_x
   - Anchor: `final_history_delete_x`
   - Tool: use `android_tap` after the anchor is accepted or regrounded.
   - Grounding: Use final_history_delete_x when its valid_when condition holds; otherwise keep the procedure applicable_with_regrounding.
5. tap search_screen_back
   - Anchor: `search_screen_back`
   - Tool: use `android_tap` after the anchor is accepted or regrounded.
   - Grounding: Use search_screen_back when its valid_when condition holds; otherwise keep the procedure applicable_with_regrounding.

## Anchor Replay Discipline

- Do not invent substitute coordinates for a recorded anchor while the recorded UI state is still plausible.
- Visual checks may reject an unsafe state, but weak visual localization should not override a recorded coordinate.
- For fast paths, only checkpoint app state at app entry or app switches. If this checkpoint is inconclusive, stop fast execution and let the agent/LLM inspect or reground.
- Enter `applicable_with_regrounding` only after the recorded anchor attempt fails verification or the current state clearly does not match.

## Fast Path Batch

- Preferred runner: `clawmobile_skill_run_fast_path`
- Batch tool: `clawmobile_batch_execute`
- Eligible: false
- Mode: recorded_anchor_batch
- Use when: Entry state is plausible, required parameters are available, anchors are reliable enough for recorded-first replay, and the task is not high-risk.
- Fallback: If the batch fails or eligibility is false, stop and use normal stepwise execution/regrounding.
- If eligible, call the preferred runner first with the required `parameters` object instead of manually expanding each step.
- This is an optional acceleration path. It must stop on structured failure and return artifacts for normal stepwise recovery.
- If the fast path fails, inspect the structured failure and cheap UI evidence, then use `clawmobile_skill_reflect_fast_path_failure` for one bounded self-repair attempt before falling back to normal stepwise execution.
- Retry the repaired fast path at most once. If it still fails, continue with normal UI tools, record feedback, and tell the user whether another demo would help.
- If final verification text is provided, let the runner use its default `ui_dump_then_ocr` checkpoint unless the skill has a stronger deterministic verifier.
- Do not use it for high-risk actions or when entry state/required parameters are uncertain.
- Batch steps:
  - step_0_assert_initial_app_state: assert_app_state package=com.amazon.mShop.android.shopping
  - step_5_search_screen_back: tap_anchor anchor=search_screen_back
- Unsupported for batch: step_1: tap_anchor search_bar requires runtime grounding before fast-path replay (generic)
- Unsupported for batch: step_2: tap_anchor first_history_delete_x requires runtime grounding before fast-path replay (generic)
- Unsupported for batch: step_3: tap_anchor next_history_delete_x requires runtime grounding before fast-path replay (generic)
- Unsupported for batch: step_4: tap_anchor final_history_delete_x requires runtime grounding before fast-path replay (list_entry)

## Anchors

- `search_bar`: stability=observed_once, x_norm=0.237257, y_norm=0.096987, confidence=0.82
  - Anchor role: generic
  - Recorded coordinate: x=256, y=235
  - Replay priority: recorded_anchor_if_screen_matches
  - Reground only after: screen evidence no longer matches and a safer grounding source is available
  - Valid when: package=com.amazon.mShop.android.shopping; the current screen matches the recorded UI state closely enough.
- `first_history_delete_x`: stability=observed_once, x_norm=0.935125, y_norm=0.299216, confidence=0.86
  - Anchor role: generic
  - Recorded coordinate: x=1010, y=725
  - Replay priority: recorded_anchor_if_screen_matches
  - Reground only after: screen evidence no longer matches and a safer grounding source is available
  - Valid when: package=com.amazon.mShop.android.shopping; the current screen matches the recorded UI state closely enough.
- `next_history_delete_x`: stability=observed_once, x_norm=0.95088, y_norm=0.300454, confidence=0.84
  - Anchor role: generic
  - Recorded coordinate: x=1027, y=728
  - Replay priority: recorded_anchor_if_screen_matches
  - Reground only after: screen evidence no longer matches and a safer grounding source is available
  - Valid when: package=com.amazon.mShop.android.shopping; the current screen matches the recorded UI state closely enough.
- `final_history_delete_x`: stability=contextual, x_norm=0.97633, y_norm=0.306243, confidence=0.78
  - Anchor role: list_entry
  - Recorded coordinate: x=1054, y=742
  - Replay priority: recorded_anchor_if_screen_matches
  - Reground only after: screen evidence no longer matches and a safer grounding source is available
  - Valid when: package=com.amazon.mShop.android.shopping; the recorded list/grid item or equivalent regrounded item is visible.
- `search_screen_back`: stability=contextual, x_norm=0.063021, y_norm=0.096987, confidence=0.8
  - Anchor role: navigation_action
  - Recorded coordinate: x=68, y=235
  - Replay priority: recorded_anchor_if_screen_matches
  - Reground only after: the recorded navigation control does not produce the expected state change
  - Valid when: package=com.amazon.mShop.android.shopping; the recorded navigation, toolbar, or keyboard state matches this procedure point.

## Grounding Policy

- `search_bar`: use_recorded_anchor_if_screen_matches -> reground_if_uncertain
- `first_history_delete_x`: use_recorded_anchor_if_screen_matches -> reground_if_uncertain
- `next_history_delete_x`: use_recorded_anchor_if_screen_matches -> reground_if_uncertain
- `final_history_delete_x`: use_recorded_anchor_if_list_or_grid_matches -> reground_by_visible_text_if_available -> otherwise_applicable_with_regrounding
- `search_screen_back`: use_recorded_anchor_if_navigation_state_matches -> prefer_keyevent_if_equivalent_and_safer -> verify_expected_state_change

## Verification

Use checkpoint verification rather than fresh screenshot/UI-dump checks after every low-risk step.
- Mode: checkpoint
- Verify every step: false
- Cheap checks first: true
- LLM vision: on_uncertainty_or_failure
- Fresh screenshot: on_visual_need_or_failure
- Max fresh screenshots per run: 2
- Preferred observation order:
  - tool_result
  - package_activity_or_orientation
  - ui_dump_when_text_or_hierarchy_can_confirm
  - ocr_existing_screenshot_or_bounded_region
  - fresh_screenshot
  - llm_visual_judgment
- Preferred checkpoints:
  - entry
  - after_recorded_anchor_procedure
  - final
- When OCR can use an existing screenshot path, reuse that path unless the UI has changed.
- Keep raw recording screenshots as evidence; keep runtime success screenshots only when useful for feedback, and keep failure screenshots for repair.

### Task-Specific Verification Rules

- Confirm the app remains com.amazon.mShop.android.shopping / com.amazon.mShop.navigation.MainActivity during the task.
- After tapping the visible X controls, confirm the demonstrated recent-search entries no longer appear in the search suggestions list.
- If no history rows are visible after opening search, consider the task already complete.

## Prior Execution Experience

Use `clawmobile_skill_status` when structured prior execution evidence could affect this run, especially if failures or verified contexts exist.
Treat prior experience as grounding/fallback evidence, not as a reason to skip normal verification.

## Execution Feedback

After executing this generated skill, record lightweight feedback with `clawmobile_skill_record_feedback` when it is low-friction and will not disrupt the user-facing task.
Use `skill_name: amazon-clear-search-history` unless the exact skill directory is already known.
- On success, keep feedback compact: `outcome: success`, the parameters used, anchors used, and the final verification summary.
- On failure or partial completion, feedback is especially important: record `outcome: failure` or `outcome: partial`, plus `failed_step`, `failed_anchor` when known, and a concise observation summary.
- Feedback automatically updates execution counts, verified contexts, and failure patterns for future runs.
- If execution fails because an anchor, entry state, or app layout is wrong, tell the user they can record a correction demo for the same task and update this skill with `clawmobile_skill_update_from_trace`.
- Feedback is a maintenance aid for future runs; it should not block normal verification or user reporting.
- Correction demo hint: To improve clear_amazon_visible_search_history, record another demonstration of the same task from the state that failed or from the preferred starting state, then update the existing skill instead of creating an unrelated one.

## Evolution

- Can update from future traces: true
- Success count: 0
- Failure count: 0
- Uncertainty: Single-trace draft: anchor stability has not been proven across devices, layouts, or app versions.
- Uncertainty: The recording begins in Android Settings before Amazon is foregrounded; that setup/navigation is not part of the Amazon history-clearing task.
- Uncertainty: The trace demonstrates deleting three visible recent-search suggestions (floor lamp, hdmi cable, usb c cable); it does not prove a global clear-all history option or account-wide search-history deletion.
- Uncertainty: Steps after returning from the search screen appear to navigate to the cart and interact with other UI/keyboard controls; they are omitted as outside the requested clear-search-history task.
- Uncertainty: The final visible state in the trace is not the emptied search screen, so verification should happen immediately after the delete actions rather than from the recording's last screenshot.
