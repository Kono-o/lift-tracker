import type { Action } from "svelte/action";
import {
	clampBaseKgFieldInput,
	clampExerciseNameFieldInput,
	clampIncrementKgFieldInput,
	clampIncrementSecFieldInput,
	clampMinsFieldInput,
	clampRepsFieldInput,
	clampRestMinsFieldInput,
	clampRestSecsFieldInput,
	clampSecsFieldInput,
	clampSetsFieldInput,
	clampTemplateNameFieldInput,
	clampTrackedRepsFieldInput,
	MAX_EXERCISE_NAME_LEN,
	MAX_TEMPLATE_NAME_LEN,
	syncClampedInput,
	type ClampedFieldInput,
	type ClampedTextFieldInput,
} from "./exerciseSanitize";
import {
	clampStatNameFieldInput,
	clampStatUnitFieldInput,
	clampStatValueFieldInput,
	clampStatLogFieldInput,
	MAX_STAT_NAME_LEN,
	MAX_STAT_UNIT_LEN,
} from "./statSanitize";

export type NumericPropKind =
	| "sets"
	| "reps"
	| "mins"
	| "secs"
	| "restMins"
	| "restSecs"
	| "baseKg"
	| "incKg"
	| "incSec"
	| "trackedReps"
	| "statValue"
	| "statLog";

const NUMERIC_CLAMPERS: Record<
	NumericPropKind,
	(raw: string) => ClampedFieldInput
> = {
	sets: clampSetsFieldInput,
	reps: clampRepsFieldInput,
	mins: clampMinsFieldInput,
	secs: clampSecsFieldInput,
	restMins: clampRestMinsFieldInput,
	restSecs: clampRestSecsFieldInput,
	baseKg: clampBaseKgFieldInput,
	incKg: clampIncrementKgFieldInput,
	incSec: clampIncrementSecFieldInput,
	trackedReps: clampTrackedRepsFieldInput,
	statValue: clampStatValueFieldInput,
	statLog: clampStatLogFieldInput,
};

function emptyIfZeroKind(kind: NumericPropKind): boolean {
	return (
		kind === "sets" ||
		kind === "reps" ||
		kind === "secs" ||
		kind === "statValue" ||
		kind === "statLog"
	);
}

function formatNumericDisplay(kind: NumericPropKind, value: number): string {
	if (emptyIfZeroKind(kind) && value === 0) return "";
	return String(value);
}

export type ClampedNumericPropParams = {
	kind: NumericPropKind;
	getValue: () => number;
	setValue: (value: number) => void;
};

/** Live clamp for template editor + workout numeric property fields. */
export const clampedNumericProp: Action<
	HTMLInputElement,
	ClampedNumericPropParams
> = (node, params) => {
	let p = params;

	function syncFromModel() {
		const display = formatNumericDisplay(p.kind, p.getValue());
		if (node.value !== display) node.value = display;
	}

	function onInput() {
		const { value, display } = NUMERIC_CLAMPERS[p.kind](node.value);
		p.setValue(value);
		syncClampedInput(node, display);
	}

	node.addEventListener("input", onInput);
	syncFromModel();

	return {
		update(next: ClampedNumericPropParams) {
			p = next;
			syncFromModel();
		},
		destroy() {
			node.removeEventListener("input", onInput);
		},
	};
};

type ClampedTextPropParams = {
	getValue: () => string;
	setValue: (value: string) => void;
};

function createClampedTextProp(
	clamp: (raw: string) => ClampedTextFieldInput,
	maxLen: number,
): Action<HTMLInputElement, ClampedTextPropParams> {
	return (node, params) => {
		let p = params;
		node.maxLength = maxLen;

		function apply(raw: string) {
			const { value, display } = clamp(raw);
			p.setValue(value);
			syncClampedInput(node, display);
			return value;
		}

		function syncFromModel() {
			apply(p.getValue());
		}

		function onInput() {
			apply(node.value);
		}

		function onPaste(e: ClipboardEvent) {
			e.preventDefault();
			const paste = e.clipboardData?.getData("text") ?? "";
			const start = node.selectionStart ?? node.value.length;
			const end = node.selectionEnd ?? node.value.length;
			apply(node.value.slice(0, start) + paste + node.value.slice(end));
		}

		function onBeforeInput(e: InputEvent) {
			if (e.isComposing) return;
			if (e.inputType?.startsWith("delete")) return;
			const data = e.data;
			if (data == null) return;

			// Allow whitespace in name fields (spaces etc. are preserved by the name clamp/sanitize which no longer trims)
			if (data.trim() === '') {
				return;
			}

			const start = node.selectionStart ?? node.value.length;
			const end = node.selectionEnd ?? node.value.length;
			const merged = node.value.slice(0, start) + data + node.value.slice(end);
			const { display } = clamp(merged);
			if (merged !== display) {
				e.preventDefault();
				apply(merged);
				const caret = Math.min(display.length, start + data.length);
				node.setSelectionRange(caret, caret);
			}
		}

		node.addEventListener("input", onInput);
		node.addEventListener("paste", onPaste);
		node.addEventListener("beforeinput", onBeforeInput);
		syncFromModel();

		return {
			update(next: ClampedTextPropParams) {
				p = next;
				syncFromModel();
			},
			destroy() {
				node.removeEventListener("input", onInput);
				node.removeEventListener("paste", onPaste);
				node.removeEventListener("beforeinput", onBeforeInput);
			},
		};
	};
}

export type ClampedTemplateNameParams = ClampedTextPropParams;
export type ClampedExerciseNameParams = ClampedTextPropParams;

/** Live clamp: template names ≤18 chars, always uppercase. */
export const clampedTemplateNameProp = createClampedTextProp(
	clampTemplateNameFieldInput,
	MAX_TEMPLATE_NAME_LEN,
);

/** Live clamp: exercise names ≤24 chars, always uppercase. */
export const clampedExerciseNameProp = createClampedTextProp(
	clampExerciseNameFieldInput,
	MAX_EXERCISE_NAME_LEN,
);

/** Live clamp: stat names ≤24 chars, always uppercase. */
export const clampedStatNameProp = createClampedTextProp(
	clampStatNameFieldInput,
	MAX_STAT_NAME_LEN,
);

/** Live clamp: stat units ≤6 chars, always uppercase. */
export const clampedStatUnitProp = createClampedTextProp(
	clampStatUnitFieldInput,
	MAX_STAT_UNIT_LEN,
);