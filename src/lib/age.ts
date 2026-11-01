/**
 * Calendar age from a date of birth.
 *
 * We store only the birth date, never the age, so the number stays correct on its
 * own — nothing to update on a birthday, nothing to drift if the app is not opened
 * for a month.
 *
 * Dates are handled as calendar fields rather than `Date` instants: `new Date
 * ("1995-03-07")` is parsed as UTC midnight, so reading it back with local getters
 * shifts the day for any west-of-UTC user. Parsing the components keeps age
 * arithmetic timezone-independent.
 */

export type Age = {
	years: number;
	months: number;
	days: number;
	/** Whole days lived, used for the fractional age the metric formulas want. */
	totalDays: number;
};

export type DateParts = { year: number; month: number; day: number };

const DAYS_PER_YEAR = 365.2425;

export function parseDateOnly(iso: string | null | undefined): DateParts | null {
	if (!iso) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const calendarDate = new Date(Date.UTC(year, month - 1, day));
	if (
		calendarDate.getUTCFullYear() !== year ||
		calendarDate.getUTCMonth() !== month - 1 ||
		calendarDate.getUTCDate() !== day
	) return null;
	return { year, month, day };
}

/** Last day of the month that has `months1` months before `year`/`month1` (both 1-based). */
function daysInPrevMonth(year: number, month1: number): number {
	// month1 - 1 as a 0-based month gives the month before it; day 0 rolls back to its last day.
	return new Date(Date.UTC(year, month1 - 1, 0)).getUTCDate();
}

export function ageFromDob(
	dobIso: string | null | undefined,
	at: Date = new Date(),
): Age | null {
	const dob = parseDateOnly(dobIso);
	if (!dob) return null;

	const atYear = at.getFullYear();
	const atMonth = at.getMonth() + 1;
	const atDay = at.getDate();

	const totalDays = Math.floor(
		(Date.UTC(atYear, atMonth - 1, atDay) - Date.UTC(dob.year, dob.month - 1, dob.day)) / 86_400_000,
	);
	if (totalDays < 0) return null;

	let years = atYear - dob.year;
	let months = atMonth - dob.month;
	let days = atDay - dob.day;

	if (days < 0) {
		months -= 1;
		days += daysInPrevMonth(atYear, atMonth);
	}
	if (months < 0) {
		years -= 1;
		months += 12;
	}

	return { years, months, days, totalDays };
}

/** Fractional years — what the body-composition formulas expect. */
export function ageYearsDecimal(age: Age | null): number | null {
	if (!age) return null;
	return age.totalDays / DAYS_PER_YEAR;
}

export function formatAge(age: Age | null): string {
	if (!age) return '—';
	const parts: string[] = [];
	if (age.years > 0) parts.push(`${age.years} yr`);
	if (age.months > 0 || age.years === 0) parts.push(`${age.months} mo`);
	parts.push(`${age.days} d`);
	return parts.join(' ');
}

export function todayIso(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Oldest DOB we support and the latest one a user may pick (today). */
export function dobBounds(): { min: string; max: string } {
	return { min: '1900-01-01', max: todayIso() };
}
