/**
 * Display-only unit conversion for body measurements.
 *
 * Everything is stored in kg / cm. The `body_units` preference changes nothing but
 * how those numbers are rendered and parsed at the edge of a text input, so
 * switching units cannot corrupt history and stays consistent with lifting
 * weights, which are always kg.
 */

export type BodyUnits = "metric" | "imperial";

const KG_PER_LB = 0.45359237;
const CM_PER_IN = 2.54;

export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const cmToIn = (cm: number): number => cm / CM_PER_IN;
export const inToCm = (inches: number): number => inches * CM_PER_IN;

export const massUnit = (units: BodyUnits): string => (units === "imperial" ? "lb" : "kg");

/** kg → display value for the chosen system. */
export const toDisplayMass = (kg: number, units: BodyUnits): number =>
	units === "imperial" ? kgToLb(kg) : kg;

/** Display value typed by the user → canonical kg. */
export const fromDisplayMass = (value: number, units: BodyUnits): number =>
	units === "imperial" ? lbToKg(value) : value;

function trim(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function formatBodyMass(
	kg: number | null | undefined,
	units: BodyUnits,
	options: { digits?: number; withUnit?: boolean } = {},
): string {
	if (kg == null || !Number.isFinite(kg)) return "—";
	const digits = options.digits ?? 1;
	const text = trim(toDisplayMass(kg, units), digits);
	return options.withUnit === false ? text : `${text} ${massUnit(units)}`;
}

/** Signed delta, e.g. "-1.4 kg". Zero stays neutral rather than reading "+0.0". */
export function formatBodyMassDelta(kgDelta: number | null | undefined, units: BodyUnits): string {
	if (kgDelta == null || !Number.isFinite(kgDelta) || Math.abs(kgDelta) < 0.05) {
		return `0 ${massUnit(units)}`;
	}
	const sign = kgDelta > 0 ? "+" : "−";
	return `${sign}${formatBodyMass(Math.abs(kgDelta), units, { withUnit: false })} ${massUnit(units)}`;
}

export function formatHeight(cm: number | null | undefined, units: BodyUnits): string {
	if (cm == null || !Number.isFinite(cm)) return "—";
	if (units !== "imperial") return `${trim(cm, 1)} cm`;
	const totalIn = cmToIn(cm);
	const feet = Math.floor(totalIn / 12);
	const inches = totalIn - feet * 12;
	return `${feet}′${trim(inches, 1)}″`;
}

/** The unit a height input is expecting, for the label next to the field. */
export const heightUnit = (units: BodyUnits): string => (units === "imperial" ? "in" : "cm");

export const toDisplayHeight = (cm: number, units: BodyUnits): number =>
	units === "imperial" ? cmToIn(cm) : cm;

export const fromDisplayHeight = (value: number, units: BodyUnits): number =>
	units === "imperial" ? inToCm(value) : value;

/** Plausible typing range in display units, used to reject transposed input. */
export function massRange(units: BodyUnits): { min: number; max: number } {
	return units === "imperial" ? { min: 20, max: 1100 } : { min: 20, max: 500 };
}
