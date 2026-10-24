import { createClient, type User } from "@supabase/supabase-js";
import {
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import {
	DEFAULT_TARGET_REPS,
	DEFAULT_TARGET_SECONDS,
	sanitizeBaseKg,
	sanitizeExerciseName,
	sanitizeTemplateName,
	sanitizeExerciseRowForDb,
	validateDraftExercise,
	validateDraftExercises,
	type DraftExerciseLike,
} from "./exerciseSanitize";
import {
	sanitizeStatRowForDb,
	toTrackedStat,
	validateDraftStats,
	type DraftStatLike,
} from "./statSanitize";
import { createDbTrackingFetch, pulseDbActivity } from "./dbActivity";
import { getNativeOAuthRedirectUrl, isNativeApp } from "./native";
import { clampItemIcon, DEFAULT_ITEM_ICON, DEFAULT_TEMPLATE_ICON } from "./itemIcons";
import { clampTemplateColor, getTemplateColor, hexToNearestIndex } from "./templateColor";
import { APP_VERSION } from "./version";

export const supabase = createClient(
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
	{
		auth: {
			flowType: "pkce",
			detectSessionInUrl: true,
			persistSession: true,
			autoRefreshToken: true,
		},
		global: {
			fetch: createDbTrackingFetch(),
		},
	},
);

function getOAuthRedirectUrl(): string {
	if (typeof window === "undefined") return "";
	if (isNativeApp()) return getNativeOAuthRedirectUrl();
	return `${window.location.origin}/auth/callback`;
}

type AuthProvider = "google" | "github" | "discord" | "x";

function providerLabel(provider: AuthProvider): string {
	if (provider === "google") return "Google";
	if (provider === "github") return "GitHub";
	if (provider === "discord") return "Discord";
	return "X";
}

/** Human-readable message for Supabase auth API errors. */
export function formatAuthError(
	error: unknown,
	provider?: AuthProvider,
	credential?: "email" | "username",
): string {
	const label = provider ? providerLabel(provider) : "OAuth";
	const raw =
		error && typeof error === "object"
			? ("msg" in error && typeof error.msg === "string"
					? error.msg
					: "message" in error && typeof error.message === "string"
						? error.message
						: null)
			: typeof error === "string"
				? error
				: null;

	if (raw?.toLowerCase().includes("provider is not enabled")) {
		return `${label} sign-in is not enabled in your Supabase project. Open the Supabase dashboard → Authentication → Providers, enable ${label}, and add your OAuth client ID and secret.`;
	}

	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: null;
	const lower = raw?.toLowerCase() ?? "";

	if (
		code === "email_address_invalid" ||
		(lower.includes("email address") && lower.includes("invalid"))
	) {
		return "That username could not be registered. Try a different username or use email sign-in.";
	}
	if (
		code === "over_email_send_rate_limit" ||
		code === "over_request_rate_limit" ||
		lower.includes("rate limit") ||
		lower.includes("too many requests")
	) {
		return "Email rate limit exceeded — Supabase only allows a few auth emails per hour on the free mailer. Wait about an hour, use username or OAuth sign-in, or in the Supabase dashboard turn off Authentication → Email → Confirm email (and use custom SMTP for real email sign-up).";
	}
	if (lower.includes("email not confirmed")) {
		return "Confirm your email first — check your inbox for the sign-up link.";
	}
	if (lower.includes("invalid login credentials")) {
		if (credential === "email") return "Incorrect email or password.";
		if (credential === "username") return "Incorrect username or password.";
		return "Incorrect sign-in credentials.";
	}
	if (
		code === "23505" ||
		lower.includes("unique constraint") ||
		lower.includes("usernames_pkey") ||
		lower.includes("duplicate key")
	) {
		if (credential === "email") {
			return "An account with this email already exists. Sign in instead.";
		}
		return "This username is already taken. Sign in instead.";
	}
	if (
		code === "user_already_exists" ||
		code === "email_exists" ||
		lower.includes("user already registered") ||
		lower.includes("already registered") ||
		lower.includes("already been registered")
	) {
		if (credential === "email") {
			return "An account with this email already exists. Sign in instead.";
		}
		return "This username is already taken. Sign in instead.";
	}
	if (code === "user_not_found" || lower.includes("user not found")) {
		if (credential === "email") return "No account with this email. Sign up first.";
		if (credential === "username") return "No account with this username. Sign up first.";
	}
	if (lower.includes("password") && lower.includes("least") && raw) {
		return raw;
	}
	if (code === "weak_password" || lower.includes("weak password")) {
		return "Password is too weak. Use at least 6 characters.";
	}
	if (code === "same_password") {
		return CHANGE_PASSWORD_SAME_AS_OLD;
	}

	return raw ?? "Sign-in failed. Please try again.";
}

export const MAX_PASSWORD_LEN = 24;
export const MIN_PASSWORD_LEN = 6;
export const CHANGE_PASSWORD_SAME_AS_OLD = "new password cannot be same as old";

/** Live typing: cap password length. */
export function sanitizePasswordInput(raw: string): string {
	return raw.slice(0, MAX_PASSWORD_LEN);
}

export function validatePassword(raw: string): string | null {
	const password = sanitizePasswordInput(raw);
	if (password.length < MIN_PASSWORD_LEN) {
		return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
	}
	if (password.length > MAX_PASSWORD_LEN) {
		return `Password must be at most ${MAX_PASSWORD_LEN} characters.`;
	}
	return null;
}

/** Human-readable message for Supabase data API errors (templates, schedule, etc.). */
export function formatDbError(error: unknown): string {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
	const raw =
		error && typeof error === "object" && "message" in error
			? String(error.message)
			: typeof error === "string"
				? error
				: null;
	const lower = raw?.toLowerCase() ?? "";

	if (
		code === "23503" ||
		lower.includes("templates_routine_id_fkey") ||
		lower.includes("violates foreign key constraint")
	) {
		return "Your session is no longer valid (account may have been removed). Sign out and sign in again.";
	}
	if (code === "42501" || lower.includes("row-level security")) {
		return "Not signed in or session expired. Sign in again.";
	}
	if (
		code === "23514" ||
		lower.includes("workout_history_duration_seconds_check")
	) {
		if (lower.includes("exercises_")) {
			return "Could not import exercise — invalid sets/reps/time fields.";
		}
		if (lower.includes("workout_history_duration_seconds_check")) {
			return "Could not save workout — invalid duration. Try finishing again after a few seconds.";
		}
		return raw ?? "Could not save — a value failed validation.";
	}

	return raw ?? "Could not save. Please try again.";
}

function getSupabaseSqlEditorHint(): string {
	try {
		const ref = new URL(PUBLIC_SUPABASE_URL).hostname.split(".")[0];
		if (ref) {
			return `https://supabase.com/dashboard/project/${ref}/sql/new — paste and run supabase/setup.sql`;
		}
	} catch {
		/* ignore */
	}
	return "Supabase Dashboard → SQL Editor — paste and run supabase/setup.sql";
}

export function isMissingDeleteAccountRpc(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = "code" in error ? String(error.code) : "";
	const message =
		"message" in error && typeof error.message === "string"
			? error.message.toLowerCase()
			: "";
	return (
		code === "PGRST202" ||
		message.includes("could not find the function") ||
		message.includes("delete_own_account")
	);
}

/** Account panel / deletion errors (separate from sign-in copy). */
export function formatAccountError(error: unknown): string {
	const raw =
		error && typeof error === "object"
			? ("message" in error && typeof error.message === "string"
					? error.message
					: null)
			: typeof error === "string"
				? error
				: null;
	const lower = raw?.toLowerCase() ?? "";

	if (lower.includes("not authenticated") || lower.includes("not signed in")) {
		return "Session expired. Sign in again, then retry.";
	}
	if (
		isMissingDeleteAccountRpc(error) ||
		lower.includes("function public.delete_own_account") ||
		lower.includes("schema cache") ||
		lower.includes("server missing supabase_service_role_key")
	) {
		return `Account deletion is not set up yet. ${getSupabaseSqlEditorHint()}`;
	}
	if (lower.includes("your workout data was removed")) {
		return raw!;
	}
	if (
		lower.includes("username already taken") ||
		lower.includes("usernames_pkey") ||
		lower.includes("23505")
	) {
		return "This username is already taken.";
	}
	if (lower.includes("invalid username")) {
		return "Use 3–24 characters: letters, numbers, underscores, and hyphens.";
	}
	if (
		lower.includes("could not find the function") ||
		lower.includes("rename_username")
	) {
		return `Username rename is not set up yet. ${getSupabaseSqlEditorHint()}`;
	}

	return raw ?? "Could not complete account action. Please try again.";
}

export function validateEmail(raw: string): string | null {
	const email = raw.trim();
	if (!email) return "Enter your email address.";
	if (email.length > 254) return "Email address is too long.";
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return "Enter a valid email address.";
	}
	return null;
}

/** Supabase may return a user with no identities when sign-up email/username already exists. */
export function isDuplicateSignupResponse(user: User | null | undefined): boolean {
	if (!user) return false;
	return !user.identities || user.identities.length === 0;
}

function getEmailRedirectUrl(): string {
	if (typeof window === "undefined") return "";
	return `${window.location.origin}/auth/callback`;
}

/** RFC 2606 reserved domain — accepted by Supabase; never shown to users. */
const USERNAME_AUTH_EMAIL_DOMAIN = "example.com";
const USERNAME_AUTH_LOCAL_PREFIX = "lt_";

/** Older builds used these; kept for sign-in only. */
const LEGACY_USERNAME_EMAIL_SUFFIXES = [
	"@users.lifttracker.app",
	"@user.lifttracker.app",
] as const;

export const MAX_USERNAME_LEN = 24;
export const MIN_USERNAME_LEN = 3;
const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

export function normalizeUsername(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Live typing: lowercase, allowed chars only, max length. */
export function sanitizeUsernameInput(raw: string): string {
	return normalizeUsername(raw)
		.replace(/[^a-z0-9_-]/g, "")
		.slice(0, MAX_USERNAME_LEN);
}

export function validateUsername(raw: string): string | null {
	const username = sanitizeUsernameInput(raw);
	if (username.length < MIN_USERNAME_LEN) {
		return `Username must be at least ${MIN_USERNAME_LEN} characters.`;
	}
	if (username.length > MAX_USERNAME_LEN) {
		return `Username must be at most ${MAX_USERNAME_LEN} characters.`;
	}
	if (!USERNAME_PATTERN.test(username)) {
		return "Use only letters, numbers, underscores, and hyphens.";
	}
	return null;
}

/** Maps username → internal auth email (not shown in UI). */
export function usernameToAuthEmail(username: string): string {
	const normalized = normalizeUsername(username);
	return `${USERNAME_AUTH_LOCAL_PREFIX}${normalized}@${USERNAME_AUTH_EMAIL_DOMAIN}`;
}

function legacyUsernameAuthEmails(username: string): string[] {
	const normalized = normalizeUsername(username);
	return LEGACY_USERNAME_EMAIL_SUFFIXES.map((suffix) => `${normalized}${suffix}`);
}

function usernameFromInternalEmail(email: string): string | null {
	const at = email.indexOf("@");
	if (at < 1) return null;
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	if (domain === USERNAME_AUTH_EMAIL_DOMAIN && local.startsWith(USERNAME_AUTH_LOCAL_PREFIX)) {
		return local.slice(USERNAME_AUTH_LOCAL_PREFIX.length) || null;
	}
	for (const suffix of LEGACY_USERNAME_EMAIL_SUFFIXES) {
		if (email.endsWith(suffix)) {
			return email.slice(0, -suffix.length) || null;
		}
	}
	return null;
}

export function getAuthDisplayName(user: User | null | undefined): string {
	if (!user) return "—";
	const meta = user.user_metadata?.username;
	if (typeof meta === "string" && meta.length > 0) return meta;
	const email = user.email ?? "";
	const fromEmail = usernameFromInternalEmail(email);
	if (fromEmail) return fromEmail;
	return email || "—";
}

export function isUsernameAccount(user: User | null | undefined): boolean {
	if (!user) return false;
	if (typeof user.user_metadata?.username === "string") return true;
	return usernameFromInternalEmail(user.email ?? "") !== null;
}

/** Email/username accounts can update password; OAuth-only accounts cannot. */
export function canChangePassword(user: User | null | undefined): boolean {
	if (!user) return false;
	if (isUsernameAccount(user)) return true;
	const identities = user.identities ?? [];
	if (identities.some((identity) => identity.provider === "email")) {
		return true;
	}
	const provider = user.app_metadata?.provider;
	return provider === "email";
}

/** Read OAuth error params Supabase appends to the redirect URL. */
export function getAuthRedirectError(): string | null {
	if (typeof window === "undefined") return null;

	const url = new URL(window.location.href);
	const description = url.searchParams.get("error_description");
	const code = url.searchParams.get("error");
	if (!description && !code) return null;

	if (description?.toLowerCase().includes("provider is not enabled")) {
		return formatAuthError({ msg: description });
	}

	return description ?? code;
}

function clearAuthRedirectParams(): void {
	if (typeof window === "undefined") return;

	const url = new URL(window.location.href);
	const hadAuthParams =
		url.searchParams.has("error") ||
		url.searchParams.has("error_description") ||
		url.searchParams.has("code") ||
		url.searchParams.has("state");

	if (!hadAuthParams) return;

	for (const key of [
		"error",
		"error_description",
		"code",
		"state",
		"token_hash",
		"type",
	]) {
		url.searchParams.delete(key);
	}
	const clean = `${url.pathname}${url.search}${url.hash}`;
	window.history.replaceState({}, "", clean || "/");
}

// ============================================================
// TYPES
// ============================================================

export interface Exercise {
	id: string;
	user_id: string;

	name: string;
	exercise_type: "reps" | "time";

	target_sets: number;
	target_reps: number;

	target_minutes: number;
	target_seconds: number;

	rest_minutes: number;
	rest_seconds: number;

	increment: number;
	current_weight: number | null;

	/** wger catalog provenance (nullable for custom exercises). */
	catalog_exercise_id?: number | null;
	catalog_muscle_ids?: number[];
	notes?: string | null;

	/** Present when an exercise is loaded in template context. */
	display_order?: number;
	/** Per-day values applied to this template instance (already merged into fields). */
	override?: ExerciseOverride;
	/** True when this template entry chains into the next exercise (superset). */
	superset_with_next?: boolean;
}

export interface ExerciseOverride {
	target_sets?: number;
	target_reps?: number;
	target_minutes?: number;
	target_seconds?: number;
	rest_minutes?: number;
	rest_seconds?: number;
	increment?: number;
	current_weight?: number | null;
}

const PERSISTED_EXERCISE_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPersistedExerciseId(id: string | null | undefined): boolean {
	return !!id && PERSISTED_EXERCISE_ID_RE.test(id) && !id.startsWith("temp-");
}

async function fetchExercisesForIds(exerciseIds: string[]): Promise<Exercise[]> {
	if (exerciseIds.length === 0) return [];
	const { data, error } = await supabase
		.from("exercises")
		.select(
			"id, user_id, name, exercise_type, target_sets, target_reps, target_minutes, target_seconds, rest_minutes, rest_seconds, increment, current_weight, catalog_exercise_id, catalog_muscle_ids, notes, created_at",
		)
		.in("id", exerciseIds);
	if (error) throw error;
	const byId = new Map((data ?? []).map((e: any) => [e.id, normalizeExerciseFromDb(e as Exercise)]));
	return exerciseIds
		.map((id) => byId.get(id) ?? null)
		.filter((e): e is Exercise => e !== null);
}

function exerciseRowForDb(
	uid: string,
	safe: ReturnType<typeof sanitizeExerciseRowForDb>,
	exerciseId?: string,
): Record<string, unknown> {
	const base =
		safe.exercise_type === "reps"
			? {
					user_id: uid,
					name: safe.name,
					exercise_type: "reps" as const,
					target_sets: safe.target_sets ?? 0,
					target_reps: safe.target_reps ?? 0,
					target_minutes: null,
					target_seconds: null,
					rest_minutes: safe.rest_minutes ?? 0,
					rest_seconds: safe.rest_seconds ?? 0,
					increment: safe.increment ?? 0,
					current_weight: safe.current_weight ?? null,
				}
			: {
					user_id: uid,
					name: safe.name,
					exercise_type: "time" as const,
					target_sets: safe.target_sets ?? 0,
					target_reps: null,
					target_minutes: safe.target_minutes ?? 0,
					target_seconds: safe.target_seconds ?? 0,
					rest_minutes: safe.rest_minutes ?? 0,
					rest_seconds: safe.rest_seconds ?? 0,
					increment: safe.increment ?? 0,
					current_weight: null,
				};
	if (exerciseId) return { ...base, id: exerciseId };
	return base;
}

// fetchExercisesForTemplate removed — use fetchExercisesForIds instead

export interface Template {
	id: string;
	routine_id: string;
	name: string;
	color?: number; // 0-255 quantized HSV spectrum index
	icon?: number; // 0-15 lucide set (shared with stats)
	display_order?: number;
	exercise_ids?: string[];
	exercises: Exercise[];
	/** Per-day target/weight overrides keyed by exercise id. */
	exercise_overrides?: Record<string, ExerciseOverride>;
	/** Exercise ids that chain into the next consecutive exercise. */
	superset_with_next?: string[];
	/** Owner of the routine (present for templates loaded from other users). */
	owner_id?: string | null;
	/** Read-only templates belong to another user's bookmarked routine. */
	is_readonly?: boolean;
}

export function isTemplateAssignable(
	template: Pick<Template, "exercises"> | null | undefined,
): boolean {
	return !!template && template.exercises.length > 0;
}

export interface ScheduleRow {
	user_id: string;
	day_of_week: number;
	template_id: string | null;
	updated_at: string;
}

/** 0=completed  1=skipped  2=rest  3=in_progress */
export type WorkoutStatus = 0 | 1 | 2 | 3;

export const WORKOUT_STATUS = {
	completed: 0,
	skipped: 1,
	rest: 2,
	in_progress: 3,
} as const;

export interface WorkoutHistory {
	user_id: string;
	workout_date: string;
	template_id: string | null;
	template_name_snapshot: string | null;
	workout_status: WorkoutStatus;
	is_skipped: boolean;
	duration_seconds: number | null;
	is_perfect_day: boolean;
	performance_snapshot: PerformanceSnapshot;
	workout_snapshot: WorkoutSnapshot;
	created_at: string;
}

// Typed snapshot shapes
export interface PerformanceSnapshot {
	total_volume_kg?: number;
	total_sets?: number;
	pr_count?: number;
	is_perfect_day?: boolean;
	duration_seconds?: number;
	/** Wall-clock ms when the active session started (draft restore). */
	started_at?: number;
	// Raw tracking maps used during an active session
	reps?: Record<string, number>;
	times?: Record<string, { result: string; target?: number }>;
}

export interface WorkoutSnapshotExerciseSet {
	set_number: number;
	reps_completed: number | null;
	seconds_completed: number | null;
	weight: number | null;
	is_pr: boolean;
}

export interface WorkoutSnapshotExercise {
	exercise_id: string;
	name: string;
	exercise_type: "reps" | "time";
	exercise_is_pr: boolean;
	target_sets: number;
	target_reps?: number;
	target_minutes?: number;
	target_seconds?: number;
	rest_minutes?: number;
	rest_seconds?: number;
	increment?: number;
	weight_before?: number | null;
	weight_after?: number | null;
	sets: WorkoutSnapshotExerciseSet[];
}

export interface WorkoutSnapshot {
	template_name?: string;
	duration_seconds?: number;
	is_perfect_day?: boolean;
	exercises?: WorkoutSnapshotExercise[];
	// Special-case flags
	skipped?: boolean;
	is_rest?: boolean;
	/** Saved while workout is still in progress (not finished). */
	in_progress?: boolean;
	notes?: string;
}

// ============================================================
// HELPERS
// ============================================================

async function requireUserId(): Promise<string> {
	const {
		data: { user },
		error,
	} = await supabase.auth.getUser();
	if (error) throw error;
	if (!user) throw new Error("Not signed in");
	return user.id;
}

/** Local calendar date (YYYY-MM-DD), aligned with the app's date picker. */
function localDateString(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function todayDateString(): string {
	return localDateString(new Date());
}

/** Completed (non-skipped) rows: DB rejects duration_seconds = 0. */
function normalizeCompletedWorkoutDuration(seconds: number): number {
	if (!Number.isFinite(seconds)) return 1;
	return Math.max(1, Math.round(seconds));
}

/** Parse `01m30s` or raw seconds from timer UI. */
export function parseTimeResultToSeconds(result: string): number | null {
	if (!result) return null;
	// Current format from formatTime(): MM:SS or M:SS
	let m = result.match(/(\d+):(\d{1,2})/);
	if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
	// Legacy format: 00m00s (or 0m0s)
	m = result.match(/(\d+)m(\d+)s/i);
	if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
	const n = parseFloat(result);
	return Number.isFinite(n) ? Math.round(n) : null;
}

export function isWorkoutInProgress(
	log: Pick<
		WorkoutHistory,
		"is_skipped" | "workout_status" | "workout_snapshot"
	> | null,
): boolean {
	return (
		!!log &&
		!log.is_skipped &&
		!log.workout_snapshot?.is_rest &&
		(log.workout_status === WORKOUT_STATUS.in_progress ||
			!!log.workout_snapshot?.in_progress)
	);
}

function normalizeExerciseFromDb(row: Exercise): Exercise {
	if (row.exercise_type === "reps") {
		return {
			...row,
			target_reps: row.target_reps ?? 0,
			target_minutes: 0,
			target_seconds: 0,
			rest_minutes: row.rest_minutes ?? 0,
			rest_seconds: row.rest_seconds ?? 0,
		};
	}
	return {
		...row,
		target_reps: 0,
		target_minutes: row.target_minutes ?? 0,
		target_seconds: row.target_seconds ?? 0,
		current_weight: null,
		rest_minutes: row.rest_minutes ?? 0,
		rest_seconds: row.rest_seconds ?? 0,
	};
}

function stripNullishJson<T extends Record<string, unknown>>(obj: T): T {
	return JSON.parse(JSON.stringify(obj)) as T;
}

export interface TrackedStat {
	id: string;
	user_id: string;
	name: string;
	unit: string;
	display_order: number;
	start_value: number;
	has_target: boolean;
	target_value: number | null;
	target_prefers_lower?: boolean;
	icon: number;
	/** 0–255 HSV spectrum index (same as templates.color) */
	color?: number;
}

export type StatLogSnapshotRow = {
	stat_id: string;
	log_date: string;
	value: number;
	name: string;
	unit: string;
};

export interface CompleteWorkoutResult {
	workout: WorkoutHistory;
	updatedExercises: Array<{ id: string; current_weight: number | null }>;
}

function performanceTimesToSeconds(
	times: PerformanceSnapshot["times"],
): Record<string, number> {
	const out: Record<string, number> = {};
	if (!times) return out;
	for (const [key, entry] of Object.entries(times)) {
		const raw =
			typeof entry === "number"
				? entry
				: typeof entry === "object" && entry && "result" in entry
					? parseTimeResultToSeconds(String(entry.result))
					: null;
		if (raw != null) out[key] = raw;
	}
	return out;
}

/**
 * Fetch the all-time best weight for a given exercise across all history.
 * Used to determine if a set is a new personal record.
 */
async function getExerciseAllTimeBests(
	exerciseIds: string[],
): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	if (exerciseIds.length === 0) return map;

	const { data, error } = await supabase
		.from("exercise_personal_bests")
		.select("exercise_id, best_weight")
		.in("exercise_id", exerciseIds);

	if (error) throw error;
	for (const row of data ?? []) {
		map.set(row.exercise_id, Number(row.best_weight) || 0);
	}
	return map;
}

async function getExerciseAllTimeBest(exerciseId: string): Promise<number> {
	const bests = await getExerciseAllTimeBests([exerciseId]);
	return bests.get(exerciseId) ?? 0;
}

// ============================================================
// ROUTINE TYPES
// ============================================================

export type RoutineScheduleMode = "weekly" | "cycle";

export interface Routine {
	id: string;
	user_id: string;
	name: string;
	created_at: string;
	display_order?: number;
	template_count?: number;
	schedule_mode?: RoutineScheduleMode;
	/** Number of days in a cycle plan (1–28). */
	cycle_length?: number;
	/** Local date (YYYY-MM-DD) that maps to cycle slot 0. */
	cycle_anchor_date?: string;
	/** Template id per cycle slot; null = rest. */
	cycle_slots?: Array<string | null>;
}

/** Active routine plan metadata — drives date-aware cycle resolution. */
export interface ActiveRoutinePlan extends Routine {
	is_readonly: boolean;
	owner_username?: string;
	owner_avatar_seed?: string | null;
}

/** Preference blob stored on usernames.preferences. */
export interface AppPreferences {
	theme?: "dark" | "light" | "oled";
	accent?: number;
	week_starts_on?: 0 | 1;
	haptics?: boolean;
	sounds?: boolean;
	rest_notifications?: boolean;
	workout_reminders?: boolean;
	reminder_time?: string;
	reminder_days?: number[];
	auto_rest_timer?: boolean;
	reduce_motion?: boolean;
	confirm_deletes?: boolean;
	compact_cards?: boolean;
}

export const DEFAULT_PREFERENCES: Required<AppPreferences> = {
	theme: "dark",
	accent: 242,
	week_starts_on: 0,
	haptics: true,
	sounds: true,
	rest_notifications: true,
	workout_reminders: false,
	reminder_time: "18:00",
	reminder_days: [1, 2, 3, 4, 5, 6, 0],
	auto_rest_timer: true,
	reduce_motion: false,
	confirm_deletes: true,
	compact_cards: false,
};

export interface RoutineSchedule {
	routine_id: string;
	day_of_week: number;
	template_id: string | null;
}

export interface RoutineBookmark {
	id: string;
	user_id: string;
	routine_id: string;
	created_at: string;
	display_order?: number;
}

export interface UserProfileRow {
	username: string;
	user_id: string;
	avatar_seed: string | null;
}

export interface RoutineWithOwner extends Routine {
	owner_username: string;
	owner_avatar_seed: string | null;
	schedule: Array<{ day_of_week: number; template_id: string | null }>;
}

/** Entry in the user's routines list: owned (editable) or bookmarked (read-only live link). */
export interface UserRoutineListItem extends Routine {
	/** owned = user created it; bookmarked = live link to someone else's routine */
	source: "owned" | "bookmarked";
	is_readonly: boolean;
	owner_username?: string;
	owner_avatar_seed?: string | null;
	bookmark_id?: string;
}

// ============================================================
// EXERCISE CATALOG (wger, read-only public data)
// ============================================================

export interface CatalogCategory {
	id: number;
	name: string;
}

export interface CatalogEquipment {
	id: number;
	name: string;
}

export interface CatalogMuscle {
	id: number;
	name: string;
	name_en: string | null;
	is_front: boolean;
}

export interface CatalogExerciseSummary {
	id: number;
	name: string;
	category_id: number | null;
	category_name: string | null;
	equipment: CatalogEquipment[];
	primary_muscles: CatalogMuscle[];
	secondary_muscles: CatalogMuscle[];
	license: string | null;
	license_author: string | null;
}

export interface CatalogExerciseDetail extends CatalogExerciseSummary {
	uuid: string | null;
	description: string;
	license_url: string | null;
}

export interface CatalogFilters {
	query?: string;
	categoryId?: number | null;
	equipmentId?: number | null;
	muscleId?: number | null;
	limit?: number;
	offset?: number;
}

// ============================================================
// EFFECTIVE TEMPLATE-DAY VALUES
// ============================================================

/** Merge a template's per-day override into an exercise row (non-destructive). */
export function applyExerciseOverride(
	exercise: Exercise,
	override: ExerciseOverride | null | undefined,
): Exercise {
	if (!override) return exercise;
	const merged: Exercise = { ...exercise, override };
	const numberKeys = [
		"target_sets",
		"target_reps",
		"target_minutes",
		"target_seconds",
		"rest_minutes",
		"rest_seconds",
		"increment",
	] as const;
	for (const key of numberKeys) {
		const value = override[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			(merged as unknown as Record<string, number>)[key] = value;
		}
	}
	if (override.current_weight !== undefined) {
		merged.current_weight = override.current_weight;
	}
	return merged;
}

/**
 * Resolve which template a routine assigns to a calendar date.
 * Weekly routines return null here — callers use the materialized weekday schedule.
 */
export function resolveRoutineTemplateForDate(
	routine: Pick<
		Routine,
		"schedule_mode" | "cycle_length" | "cycle_anchor_date" | "cycle_slots"
	> | null,
	dateStr: string,
): string | null {
	if (!routine || routine.schedule_mode !== "cycle") return null;
	const slots = Array.isArray(routine.cycle_slots) ? routine.cycle_slots : [];
	const length = Math.max(1, Math.min(28, routine.cycle_length ?? (slots.length || 1)));
	if (slots.length === 0) return null;
	const anchorStr = routine.cycle_anchor_date;
	if (!anchorStr) return null;
	const [ay, am, ad] = anchorStr.split("-").map(Number);
	const [dy, dm, dd] = dateStr.split("-").map(Number);
	if (!ay || !am || !ad || !dy || !dm || !dd) return null;
	const anchor = Date.UTC(ay, am - 1, ad);
	const date = Date.UTC(dy, dm - 1, dd);
	const diffDays = Math.round((date - anchor) / 86_400_000);
	const idx = ((diffDays % length) + length) % length;
	return slots[idx] ?? null;
}

/** Cycle slot preview labels for editors. */
export function cycleSlotDates(
	anchorDate: string,
	length: number,
): string[] {
	const [ay, am, ad] = anchorDate.split("-").map(Number);
	if (!ay || !am || !ad) return [];
	const base = Date.UTC(ay, am - 1, ad);
	const out: string[] = [];
	for (let i = 0; i < length; i++) {
		const d = new Date(base + i * 86_400_000);
		out.push(
			`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
		);
	}
	return out;
}

function catalogSummaryFromRow(row: any): CatalogExerciseSummary {
	const equipment: CatalogEquipment[] = [];
	const primary: CatalogMuscle[] = [];
	const secondary: CatalogMuscle[] = [];
	for (const link of row.wger_exercise_equipment ?? []) {
		const eq = link?.wger_equipment;
		if (eq?.id) equipment.push({ id: eq.id, name: eq.name });
	}
	for (const link of row.wger_exercise_muscles ?? []) {
		const m = link?.wger_muscles;
		if (!m?.id) continue;
		const muscle: CatalogMuscle = {
			id: m.id,
			name: m.name,
			name_en: m.name_en ?? null,
			is_front: m.is_front !== false,
		};
		(link.is_primary === false ? secondary : primary).push(muscle);
	}
	const dedupe = <T extends { id: number }>(items: T[]) =>
		[...new Map(items.map((item) => [item.id, item])).values()];
	return {
		id: row.id,
		name: row.name,
		category_id: row.category_id ?? null,
		category_name: row.wger_categories?.name ?? null,
		equipment: dedupe(equipment),
		primary_muscles: dedupe(primary),
		secondary_muscles: dedupe(secondary),
		license: row.license ?? null,
		license_author: row.license_author ?? null,
	};
}

// ============================================================
// DB LAYER
// ============================================================

export const db = {
	/* ==================================================
		 AUTH
		 ================================================== */

	async signInWithGitHub() {
		const { error } = await supabase.auth.signInWithOAuth({
			provider: "github",
			options: { redirectTo: getOAuthRedirectUrl() },
		});
		if (error) throw error;
	},

	async signInWithGoogle() {
		const { error } = await supabase.auth.signInWithOAuth({
			provider: "google",
			options: { redirectTo: getOAuthRedirectUrl() },
		});
		if (error) throw error;
	},

	async signInWithDiscord() {
		const { error } = await supabase.auth.signInWithOAuth({
			provider: "discord",
			options: { redirectTo: getOAuthRedirectUrl() },
		});
		if (error) throw error;
	},

	async signInWithX() {
		const { error } = await supabase.auth.signInWithOAuth({
			provider: "twitter",
			options: { redirectTo: getOAuthRedirectUrl() },
		});
		if (error) throw error;
	},

	async isUsernameAvailable(username: string): Promise<boolean> {
		const validationError = validateUsername(username);
		if (validationError) return false;

		const { data, error } = await supabase.rpc("is_username_available", {
			p_username: normalizeUsername(username),
		});

		if (error) {
			// Migration not applied yet — auth email uniqueness still applies at sign-up.
			if (
				error.code === "PGRST202" ||
				error.message?.toLowerCase().includes("could not find the function")
			) {
				return true;
			}
			throw error;
		}

		return data === true;
	},

	async registerUsername(username: string): Promise<void> {
		const normalized = normalizeUsername(username);
		const { error } = await supabase.rpc("register_username", {
			p_username: normalized,
		});
		if (error) throw error;
	},

	async renameUsername(newUsername: string): Promise<User> {
		const validationError = validateUsername(newUsername);
		if (validationError) throw new Error(validationError);

		const {
			data: { user: before },
			error: userErr,
		} = await supabase.auth.getUser();
		if (userErr) throw userErr;
		if (!before) throw new Error("Not signed in");
		if (!isUsernameAccount(before)) {
			throw new Error("Only username accounts can be renamed here.");
		}

		const normalized = normalizeUsername(newUsername);
		const current = normalizeUsername(getAuthDisplayName(before));
		if (normalized === current) return before;

		const { error } = await supabase.rpc("rename_username", {
			p_new_username: normalized,
		});
		if (error) throw error;

		const { error: refreshErr } = await supabase.auth.refreshSession();
		if (refreshErr) throw refreshErr;

		const {
			data: { user },
			error: afterErr,
		} = await supabase.auth.getUser();
		if (afterErr) throw afterErr;
		if (!user) throw new Error("Not signed in");
		return user;
	},

	async getAvatarSeed(): Promise<string | null> {
		const { data, error } = await supabase.rpc("get_avatar_seed");
		if (error) throw error;
		return data ?? null;
	},

	async saveAvatarSeed(seed: string | null): Promise<void> {
		const { error } = await supabase.rpc("save_avatar_seed", { p_seed: seed });
		if (error) throw error;
	},

	async signUpWithUsername(username: string, password: string) {
		const validationError = validateUsername(username);
		if (validationError) throw new Error(validationError);

		const passwordError = validatePassword(password);
		if (passwordError) throw new Error(passwordError);

		const normalized = normalizeUsername(username);

		const available = await this.isUsernameAvailable(normalized);
		if (!available) {
			throw Object.assign(new Error("User already registered"), {
				code: "user_already_exists",
			});
		}

		const { data, error } = await supabase.auth.signUp({
			email: usernameToAuthEmail(normalized),
			password,
			options: { data: { username: normalized } },
		});
		if (error) throw error;

		if (isDuplicateSignupResponse(data.user)) {
			throw Object.assign(new Error("User already registered"), {
				code: "user_already_exists",
			});
		}

		// Username row is created by DB trigger on auth.users (see supabase/setup.sql).

		return data;
	},

	async signInWithUsername(username: string, password: string) {
		const validationError = validateUsername(username);
		if (validationError) throw new Error(validationError);

		const passwordError = validatePassword(password);
		if (passwordError) throw new Error(passwordError);

		const normalized = normalizeUsername(username);
		const primaryEmail = usernameToAuthEmail(normalized);
		const legacyEmails = legacyUsernameAuthEmails(normalized);

		const primary = await supabase.auth.signInWithPassword({
			email: primaryEmail,
			password,
		});
		if (!primary.error) return primary.data;

		const primaryCode =
			primary.error && typeof primary.error === "object" && "code" in primary.error
				? String(primary.error.code)
				: "";

		if (
			primaryCode &&
			primaryCode !== "invalid_credentials" &&
			primaryCode !== "user_not_found"
		) {
			throw primary.error;
		}

		if (legacyEmails.length === 0) {
			if (primaryCode === "invalid_credentials") {
				throw Object.assign(new Error("Invalid login credentials"), {
					code: "invalid_credentials",
				});
			}
			throw primary.error;
		}

		const legacyAttempts = await Promise.all(
			legacyEmails.map(async (email) => {
				const { data, error } = await supabase.auth.signInWithPassword({
					email,
					password,
				});
				return { data, error };
			}),
		);

		const legacySuccess = legacyAttempts.find((attempt) => !attempt.error);
		if (legacySuccess) return legacySuccess.data;

		const sawInvalidCredentials =
			primaryCode === "invalid_credentials" ||
			legacyAttempts.some(
				(attempt) =>
					attempt.error &&
					typeof attempt.error === "object" &&
					"code" in attempt.error &&
					attempt.error.code === "invalid_credentials",
			);

		if (sawInvalidCredentials) {
			throw Object.assign(new Error("Invalid login credentials"), {
				code: "invalid_credentials",
			});
		}

		throw (
			legacyAttempts.find((attempt) => attempt.error)?.error ??
			primary.error ??
			new Error("Sign-in failed")
		);
	},

	async signUpWithEmail(email: string, password: string) {
		const emailErr = validateEmail(email);
		if (emailErr) throw new Error(emailErr);

		const passwordError = validatePassword(password);
		if (passwordError) throw new Error(passwordError);

		const trimmed = email.trim();
		const { data, error } = await supabase.auth.signUp({
			email: trimmed,
			password,
			options: { emailRedirectTo: getEmailRedirectUrl() },
		});
		if (error) throw error;

		if (isDuplicateSignupResponse(data.user)) {
			throw Object.assign(new Error("User already registered"), {
				code: "user_already_exists",
			});
		}

		return data;
	},

	async signInWithEmail(email: string, password: string) {
		const emailErr = validateEmail(email);
		if (emailErr) throw new Error(emailErr);

		const passwordError = validatePassword(password);
		if (passwordError) throw new Error(passwordError);

		if (!password) {
			throw Object.assign(new Error("Invalid login credentials"), {
				code: "invalid_credentials",
			});
		}

		const { data, error } = await supabase.auth.signInWithPassword({
			email: email.trim(),
			password,
		});
		if (error) throw error;
		return data;
	},

	/** Exchange PKCE code after OAuth redirect (safe to call when no code is present). */
	async handleAuthCallback(): Promise<void> {
		if (typeof window === "undefined") return;

		const redirectError = getAuthRedirectError();
		if (redirectError) {
			clearAuthRedirectParams();
			throw new Error(redirectError);
		}

		const url = new URL(window.location.href);
		const tokenHash = url.searchParams.get("token_hash");
		const type = url.searchParams.get("type");

		if (tokenHash && type) {
			const { error } = await supabase.auth.verifyOtp({
				token_hash: tokenHash,
				type: type as "email" | "signup" | "recovery" | "invite" | "magiclink",
			});
			if (error) throw error;
			clearAuthRedirectParams();
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) return;

		const { error } = await supabase.auth.exchangeCodeForSession(code);
		if (error) throw error;

		clearAuthRedirectParams();
	},

	async signOut() {
		const { error } = await supabase.auth.signOut();
		if (error) throw error;
	},

	async changePassword(newPassword: string) {
		const passwordError = validatePassword(newPassword);
		if (passwordError) throw new Error(passwordError);

		const {
			data: { user },
			error: userErr,
		} = await supabase.auth.getUser();
		if (userErr) throw userErr;
		if (!user?.email) throw new Error("Not signed in");

		const { data: signInData, error: signInError } =
			await supabase.auth.signInWithPassword({
				email: user.email,
				password: newPassword,
			});
		if (!signInError && signInData.session) {
			throw new Error(CHANGE_PASSWORD_SAME_AS_OLD);
		}

		const { error } = await supabase.auth.updateUser({ password: newPassword });
		if (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? String(error.code)
					: "";
			if (code === "same_password") {
				throw new Error(CHANGE_PASSWORD_SAME_AS_OLD);
			}
			throw error;
		}
	},

	/**
	 * Deletes all user data + auth user.
	 * Prefers `delete_own_account` RPC; falls back to POST /api/delete-account when
	 * SUPABASE_SERVICE_ROLE_KEY is set (see supabase/setup.sql).
	 */
	async deleteAccount() {
		const {
			data: { user },
			error: userErr,
		} = await supabase.auth.getUser();
		if (userErr) throw userErr;
		if (!user) throw new Error("Not signed in");

		const { error: rpcError } = await supabase.rpc("delete_own_account");

		if (!rpcError) {
			// The auth row is already gone; a missing session here is success,
			// not a failed deletion.
			await supabase.auth.signOut().catch(() => {});
			return;
		}

		if (!isMissingDeleteAccountRpc(rpcError)) {
			throw rpcError;
		}

		const {
			data: { session },
		} = await supabase.auth.getSession();
		if (!session?.access_token) {
			throw new Error("Not signed in");
		}

		pulseDbActivity();
		const res = await fetch("/api/delete-account", {
			method: "POST",
			headers: { Authorization: `Bearer ${session.access_token}` },
		});

		let body: { error?: string } = {};
		try {
			body = (await res.json()) as { error?: string };
		} catch {
			/* ignore */
		}

		if (!res.ok) {
			throw new Error(
				body.error ??
					`Account deletion is not set up yet. ${getSupabaseSqlEditorHint()}`,
			);
		}

		await supabase.auth.signOut().catch(() => {});
	},

	async getSession() {
		const { data, error } = await supabase.auth.getSession();
		if (error) throw error;
		return data.session;
	},

	/* ==================================================
		 APP LOAD
		 ================================================== */

	/**
	 * Build templates + exercise library from raw rows.
	 * Templates now carry exercise_ids[] (no junction table).
	 */
	_assembleAppCore(args: {
		schedule: ScheduleRow[];
		ownTemplates: any[];
		ownExercises: Exercise[];
		foreignTemplates?: any[];
		foreignExercises?: Exercise[];
		ownerId?: string | null;
		foreignOwnerId?: string | null;
	}): {
		schedule: ScheduleRow[];
		templates: Template[];
		exerciseLibrary: Exercise[];
	} {
		const {
			schedule,
			ownTemplates,
			ownExercises,
			foreignTemplates = [],
			foreignExercises = [],
			ownerId = null,
			foreignOwnerId = null,
		} = args;
		const ownTemplateIds = new Set(ownTemplates.map((t) => t.id as string));
		const exerciseLibrary = [
			...ownExercises,
			...foreignExercises.filter((e) => !ownExercises.some((o) => o.id === e.id)),
		].map(normalizeExerciseFromDb);
		const exById = new Map(exerciseLibrary.map((e) => [e.id, e] as const));

		const allTemplateRows = [
			...ownTemplates,
			...foreignTemplates.filter((t) => !ownTemplateIds.has(t.id)),
		];

		const templates: Template[] = allTemplateRows.map((t: any) => {
			const exIds: string[] = Array.isArray(t.exercise_ids) ? t.exercise_ids : [];
			const overrides =
				t.exercise_overrides && typeof t.exercise_overrides === "object"
					? (t.exercise_overrides as Record<string, ExerciseOverride>)
					: {};
			const supersetIds = new Set<string>(
				Array.isArray(t.superset_with_next) ? t.superset_with_next : [],
			);
			const exs: Exercise[] = exIds
				.map((id: string, i: number) => {
					const base = exById.get(id);
					if (!base) return null;
					const merged = applyExerciseOverride(
						{ ...base, display_order: i },
						overrides[id],
					);
					return {
						...merged,
						superset_with_next: supersetIds.has(id),
					} as Exercise;
				})
				.filter((e): e is Exercise => !!e);

			return {
				id: t.id,
				routine_id: t.routine_id,
				name: t.name,
				color: typeof t.color === "number" ? t.color : 0,
				icon: typeof (t as { icon?: number }).icon === "number"
					? clampItemIcon((t as { icon: number }).icon)
					: DEFAULT_TEMPLATE_ICON,
				display_order: typeof t.display_order === "number" ? t.display_order : 0,
				exercise_ids: exIds,
				exercises: exs,
				exercise_overrides: overrides,
				superset_with_next: [...supersetIds],
				owner_id: ownTemplateIds.has(t.id) ? ownerId : foreignOwnerId,
				is_readonly: !ownTemplateIds.has(t.id),
			};
		});

		return { schedule, templates, exerciseLibrary };
	},

	async getAppData(userId?: string | null) {
		const boot = await this.getSessionBootstrap(userId, {
			historyDays: 0,
			statDays: 0,
			includeRoutines: false,
			includeStats: false,
		});
		return {
			schedule: boot.schedule,
			templates: boot.templates,
			exerciseLibrary: boot.exerciseLibrary,
			todayLog: boot.todayLog,
		};
	},

	/**
	 * One coordinated load for app start / tab refocus: parallel fetches + one activity flash.
	 * Prefer this over many sequential getX() calls.
	 */
	async getSessionBootstrap(
		userId?: string | null,
		opts: {
			historyDays?: number;
			statDays?: number;
			includeRoutines?: boolean;
			includeStats?: boolean;
		} = {},
	): Promise<{
		schedule: ScheduleRow[];
		templates: Template[];
		exerciseLibrary: Exercise[];
		todayLog: WorkoutHistory | null;
		recentLogs: WorkoutHistory[];
		trackedStats: TrackedStat[];
		statLogSnapshots: StatLogSnapshotRow[];
		activeRoutineId: string | null;
		activeRoutinePlan: ActiveRoutinePlan | null;
		preferences: Required<AppPreferences>;
		routineList: UserRoutineListItem[];
	}> {
		const historyDays = opts.historyDays ?? 21;
		const statDays = opts.statDays ?? 90;
		const includeRoutines = opts.includeRoutines !== false;
		const includeStats = opts.includeStats !== false;

		const sinceHistory = new Date();
		sinceHistory.setDate(sinceHistory.getDate() - historyDays);
		const sinceHistoryStr = localDateString(sinceHistory);
		const sinceStats = new Date();
		sinceStats.setDate(sinceStats.getDate() - statDays);
		const sinceStatsStr = localDateString(sinceStats);
		const todayStr = todayDateString();

		// RLS exposes every community template; bootstrap must load only this user's own
		// routine templates. Bookmarked-active templates are fetched separately below.
		const templatesQ = supabase
			.from("templates")
			.select(
				"id, routine_id, name, color, icon, display_order, exercise_ids, exercise_overrides, superset_with_next, routines!inner(user_id)",
			)
			.eq("routines.user_id", userId ?? "00000000-0000-0000-0000-000000000000")
			.order("display_order")
			.order("created_at");

		const exercisesQ = supabase
			.from("exercises")
			.select(
				"id, user_id, name, exercise_type, target_sets, target_reps, target_minutes, target_seconds, rest_minutes, rest_seconds, increment, current_weight, catalog_exercise_id, catalog_muscle_ids, notes, created_at",
			)
			.order("created_at");
		if (userId) exercisesQ.eq("user_id", userId);

		const ownedRoutinesQ = userId
			? supabase
					.from("routines")
					.select(
						"id, user_id, name, created_at, display_order, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots, routine_schedules ( template_id ), templates ( id )",
					)
					.eq("user_id", userId)
					.order("display_order")
					.order("created_at")
			: null;
		const bookmarksQ = userId
			? supabase
					.from("routine_bookmarks")
					.select("id, user_id, routine_id, created_at, display_order")
					.eq("user_id", userId)
					.order("display_order")
					.order("created_at")
			: null;

		// Wave 1: everything independent in parallel
		const [
			scheduleRes,
			ownTemplatesRes,
			libraryRes,
			todayRes,
			recentRes,
			statsRes,
			snapshotsRes,
			profileRes,
			ownedRoutinesRes,
			bookmarksRes,
			usersRes,
		] = await Promise.all([
			supabase.from("schedule").select("*").order("day_of_week"),
			templatesQ,
			exercisesQ,
			supabase
				.from("workout_history")
				.select("*")
				.eq("workout_date", todayStr)
				.maybeSingle(),
			historyDays > 0
				? supabase
						.from("workout_history")
						.select("*")
						.gte("workout_date", sinceHistoryStr)
						.order("workout_date", { ascending: false })
				: Promise.resolve({ data: [], error: null }),
			includeStats
				? supabase
						.from("tracked_stats")
						.select(
							"id, user_id, name, unit, display_order, start_value, has_target, target_value, target_prefers_lower, icon, color",
						)
						.order("display_order")
						.order("created_at")
				: Promise.resolve({ data: [], error: null }),
			includeStats
				? supabase
						.from("stat_logs")
						.select(
							"stat_id, log_date, value, stat_name_snapshot, stat_unit_snapshot",
						)
						.gte("log_date", sinceStatsStr)
						.order("log_date", { ascending: false })
				: Promise.resolve({ data: [], error: null }),
			userId
				? supabase
						.from("usernames")
						.select("user_id, username, avatar_seed, active_routine_id, preferences")
						.eq("user_id", userId)
						.maybeSingle()
				: Promise.resolve({ data: null, error: null }),
			includeRoutines && ownedRoutinesQ
				? ownedRoutinesQ
				: Promise.resolve({ data: [], error: null }),
			includeRoutines && bookmarksQ
				? bookmarksQ
				: Promise.resolve({ data: [], error: null }),
			includeRoutines
				? supabase.from("usernames").select("username, user_id, avatar_seed")
				: Promise.resolve({ data: [], error: null }),
		]);

		if (scheduleRes.error) throw scheduleRes.error;
		if (ownTemplatesRes.error) throw ownTemplatesRes.error;
		if (libraryRes.error) throw libraryRes.error;
		if (todayRes.error) throw todayRes.error;

		let schedule = (scheduleRes.data ?? []) as ScheduleRow[];
		let activeRoutineId =
			(profileRes.data?.active_routine_id as string | undefined) ?? null;

		// Live-follow bookmarked active routine (one RPC + optional schedule refresh)
		if (userId && activeRoutineId) {
			const ownedIds = new Set(
				((ownedRoutinesRes.data ?? []) as Array<{ id: string }>).map((r) => r.id),
			);
			const isOwnedActive = ownedIds.has(activeRoutineId);
			if (!isOwnedActive) {
				try {
					await supabase.rpc("resync_active_bookmarked_routine");
					const { data: sched2, error: s2 } = await supabase
						.from("schedule")
						.select("*")
						.order("day_of_week");
					if (!s2 && sched2) schedule = sched2 as ScheduleRow[];
				} catch (e) {
					console.warn("resync_active_bookmarked_routine failed", e);
				}
			}
		}

		// Active routine metadata drives date-aware cycle planning.
		let activeRoutinePlan: ActiveRoutinePlan | null = null;
		if (userId && activeRoutineId) {
			const { data: rp, error: rpErr } = await supabase
				.from("routines")
				.select(
					"id, user_id, name, created_at, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots",
				)
				.eq("id", activeRoutineId)
				.maybeSingle();
			if (rpErr) {
				console.warn("active routine plan fetch failed", rpErr);
			} else if (rp) {
				const owner = ((usersRes.data ?? []) as UserProfileRow[]).find(
					(u) => u.user_id === rp.user_id,
				);
				activeRoutinePlan = {
					...(rp as Routine),
					is_readonly: rp.user_id !== userId,
					owner_username: owner?.username,
					owner_avatar_seed: owner?.avatar_seed ?? null,
				};
			}
		}

		const ownTemplates = ownTemplatesRes.data ?? [];
		const ownTemplateIds = new Set(ownTemplates.map((t: any) => t.id as string));
		const cycleTemplateIds: string[] = [];
		if (activeRoutinePlan?.schedule_mode === "cycle") {
			for (const tid of activeRoutinePlan.cycle_slots ?? []) {
				if (typeof tid === "string" && tid) cycleTemplateIds.push(tid);
			}
		}
		const foreignScheduleIds = [
			...new Set(
				[
					...schedule.map((s) => s.template_id),
					...cycleTemplateIds,
				].filter((id): id is string => !!id && !ownTemplateIds.has(id)),
			),
		];

		let foreignTemplatesData: any[] = [];
		let foreignExerciseRows: Exercise[] = [];

		if (foreignScheduleIds.length > 0) {
			const [ftRes] = await Promise.all([
				supabase
					.from("templates")
					.select(
						"id, routine_id, name, color, icon, display_order, exercise_ids, exercise_overrides, superset_with_next",
					)
					.in("id", foreignScheduleIds),
			]);
			if (ftRes.error) throw ftRes.error;
			foreignTemplatesData = ftRes.data ?? [];
			// Collect all foreign exercise IDs from templates' exercise_ids arrays
			const foreignExIds = [
				...new Set(
					foreignTemplatesData
						.flatMap((t: any) => (Array.isArray(t.exercise_ids) ? t.exercise_ids : []))
						.filter((id): id is string => typeof id === "string"),
				),
			];
			if (foreignExIds.length > 0) {
				const { data: fexs, error: fexErr } = await supabase
					.from("exercises")
					.select(
						"id, user_id, name, exercise_type, target_sets, target_reps, target_minutes, target_seconds, rest_minutes, rest_seconds, increment, current_weight, catalog_exercise_id, catalog_muscle_ids, notes, created_at",
					)
					.in("id", foreignExIds);
				if (fexErr) throw fexErr;
				foreignExerciseRows = (fexs ?? []) as Exercise[];
			}
		}

		const core = this._assembleAppCore({
			schedule,
			ownTemplates,
			ownExercises: (libraryRes.data ?? []) as Exercise[],
			foreignTemplates: foreignTemplatesData,
			foreignExercises: foreignExerciseRows,
			ownerId: userId ?? null,
			foreignOwnerId: activeRoutinePlan?.user_id ?? null,
		});

		// Routines list (owned + bookmarked) from already-fetched rows + one optional batch
		let routineList: UserRoutineListItem[] = [];
		if (includeRoutines && userId) {
			const userMap = new Map(
				((usersRes.data ?? []) as UserProfileRow[]).map((u) => [u.user_id, u]),
			);
			const ownedItems: UserRoutineListItem[] = (
				(ownedRoutinesRes.data ?? []) as any[]
			).map((r) => ({
				id: r.id,
				user_id: r.user_id,
				name: r.name,
				created_at: r.created_at,
				display_order: r.display_order ?? 0,
				template_count: Array.isArray(r.templates) ? r.templates.length : 0,
				schedule_mode: r.schedule_mode ?? "weekly",
				cycle_length: r.cycle_length ?? 7,
				cycle_anchor_date: r.cycle_anchor_date,
				cycle_slots: Array.isArray(r.cycle_slots) ? r.cycle_slots : [],
				source: "owned" as const,
				is_readonly: false,
				owner_username: userMap.get(r.user_id)?.username,
				owner_avatar_seed: userMap.get(r.user_id)?.avatar_seed ?? null,
			}));

			const bookmarks = (bookmarksRes.data ?? []) as RoutineBookmark[];
			let bookmarkedItems: UserRoutineListItem[] = [];
			if (bookmarks.length > 0) {
				const ids = bookmarks.map((b) => b.routine_id);
				const { data: remoteRoutines, error: rrErr } = await supabase
					.from("routines")
					.select(
						"id, user_id, name, created_at, display_order, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots, routine_schedules ( template_id ), templates ( id )",
					)
					.in("id", ids);
				if (rrErr) throw rrErr;
				const rMap = new Map(
					((remoteRoutines ?? []) as any[]).map((r) => [r.id, r]),
				);
				for (const bm of bookmarks) {
					const r = rMap.get(bm.routine_id);
					if (!r) continue;
					const owner = userMap.get(r.user_id);
					bookmarkedItems.push({
						id: r.id,
						user_id: r.user_id,
						name: r.name,
						created_at: r.created_at,
						display_order: bm.display_order ?? 0,
						template_count: Array.isArray(r.templates) ? r.templates.length : 0,
						schedule_mode: r.schedule_mode ?? "weekly",
						cycle_length: r.cycle_length ?? 7,
						cycle_anchor_date: r.cycle_anchor_date,
						cycle_slots: Array.isArray(r.cycle_slots) ? r.cycle_slots : [],
						source: "bookmarked",
						is_readonly: true,
						owner_username: owner?.username ?? "unknown",
						owner_avatar_seed: owner?.avatar_seed ?? null,
						bookmark_id: bm.id,
					});
				}
			}
			routineList = [...ownedItems, ...bookmarkedItems];
		}

		let trackedStats: TrackedStat[] = [];
		if (includeStats && !statsRes.error) {
			trackedStats = (statsRes.data ?? []).map((row: any, i: number) =>
				toTrackedStat(row, i),
			);
		} else if (includeStats && statsRes.error) {
			// legacy columns fallback once
			trackedStats = await this.getTrackedStats().catch(() => []);
		}

		let statLogSnapshots: StatLogSnapshotRow[] = [];
		if (includeStats && !snapshotsRes.error) {
			statLogSnapshots = ((snapshotsRes.data ?? []) as any[])
				.filter(
					(row) =>
						row.stat_id &&
						row.log_date &&
						typeof row.value === "number" &&
						row.stat_name_snapshot,
				)
				.map((row) => ({
					stat_id: row.stat_id as string,
					log_date: row.log_date as string,
					value: row.value as number,
					name: row.stat_name_snapshot as string,
					unit: (row.stat_unit_snapshot as string | null) ?? "",
				}));
		}

		const recentLogs =
			historyDays > 0 && !recentRes.error
				? ((recentRes.data as WorkoutHistory[]) ?? [])
				: [];

		const preferences: Required<AppPreferences> = {
			...DEFAULT_PREFERENCES,
			...((profileRes.data?.preferences as AppPreferences | null) ?? {}),
		};

		return {
			...core,
			todayLog: (todayRes.data as WorkoutHistory) ?? null,
			recentLogs,
			trackedStats,
			statLogSnapshots,
			activeRoutineId,
			activeRoutinePlan,
			preferences,
			routineList,
		};
	},

	/* ==================================================
		 TRACKED STATS (user-defined metrics, logged by day)
		 ================================================== */

	async getTrackedStats(): Promise<TrackedStat[]> {
		const full = await supabase
			.from("tracked_stats")
			.select(
				"id, user_id, name, unit, display_order, start_value, has_target, target_value, target_prefers_lower, icon, color",
			)
			.order("display_order")
			.order("created_at");

		if (!full.error) {
			return (full.data ?? []).map((row, i) => toTrackedStat(row, i));
		}

		const legacy = await supabase
			.from("tracked_stats")
			.select("id, user_id, name, unit, display_order")
			.order("display_order")
			.order("created_at");

		if (legacy.error) {
			console.warn("[db] tracked_stats fetch warning:", legacy.error.message);
			return [];
		}

		return (legacy.data ?? []).map((row, i) => toTrackedStat(row, i));
	},

	async getStatLogs(
		days = 90,
	): Promise<Record<string, Record<string, number>>> {
		const since = new Date();
		since.setDate(since.getDate() - days);
		const sinceStr = localDateString(since);

		const { data, error } = await supabase
			.from("stat_logs")
			.select("stat_id, log_date, value")
			.gte("log_date", sinceStr)
			.order("log_date", { ascending: false });

		if (error) {
			console.warn("[db] stat_logs fetch warning:", error.message);
			return {};
		}

		const map: Record<string, Record<string, number>> = {};
		for (const row of data ?? []) {
			if (!row.stat_id || !row.log_date || typeof row.value !== "number") {
				continue;
			}
			if (!map[row.stat_id]) map[row.stat_id] = {};
			map[row.stat_id][row.log_date] = row.value;
		}
		return map;
	},

	/** All stat log rows including snapshots for deleted stat definitions. */
	async getStatLogSnapshots(days = 90): Promise<StatLogSnapshotRow[]> {
		const since = new Date();
		since.setDate(since.getDate() - days);
		const sinceStr = localDateString(since);

		const { data, error } = await supabase
			.from("stat_logs")
			.select("stat_id, log_date, value, stat_name_snapshot, stat_unit_snapshot")
			.gte("log_date", sinceStr)
			.order("log_date", { ascending: false });

		if (error) {
			console.warn("[db] stat_log snapshots fetch warning:", error.message);
			return [];
		}

		return (data ?? [])
			.filter(
				(row) =>
					row.stat_id &&
					row.log_date &&
					typeof row.value === "number" &&
					row.stat_name_snapshot,
			)
			.map((row) => ({
				stat_id: row.stat_id as string,
				log_date: row.log_date as string,
				value: row.value as number,
				name: row.stat_name_snapshot as string,
				unit: (row.stat_unit_snapshot as string | null) ?? "",
			}));
	},

	async saveStatLog(statId: string, logDate: string, value: number) {
		const { error } = await supabase.rpc("save_stat_log", {
			p_stat_id: statId,
			p_log_date: logDate,
			p_value: value,
		});

		if (error) throw error;
	},

	async deleteStatLog(statId: string, logDate: string) {
		const { error } = await supabase
			.from("stat_logs")
			.delete()
			.eq("stat_id", statId)
			.eq("log_date", logDate);

		if (error) throw error;
	},

	async saveTrackedStats(
		stats: Array<{
			id?: string;
			name: string;
			unit?: string;
			display_order?: number;
			start_value?: number;
			has_target?: boolean;
			target_value?: number | null;
			target_prefers_lower?: boolean;
			icon?: number;
			color?: number;
		}>,
	): Promise<TrackedStat[]> {
		const validationError = validateDraftStats(stats as DraftStatLike[]);
		if (validationError) throw new Error(validationError);


		const payload = stats.map((d, i) => {
			const safe = sanitizeStatRowForDb(d as DraftStatLike);
			const row: Record<string, unknown> = {
				name: safe.name,
				unit: safe.unit ?? "",
				display_order: safe.display_order ?? i,
				start_value: safe.start_value ?? 0,
				has_target: !!safe.has_target,
				target_value: safe.has_target ? (safe.target_value ?? 0) : null,
				target_prefers_lower: safe.target_prefers_lower ?? true,
				icon: clampItemIcon(safe.icon ?? DEFAULT_ITEM_ICON),
				color: clampTemplateColor(
					typeof safe.color === "number" ? safe.color : 242,
				),
			};
			const statId = typeof d.id === "string" ? d.id : "";
			if (
				statId &&
				!statId.startsWith("temp-") &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					statId,
				)
			) {
				row.id = statId;
			}
			return row;
		});

		let { data, error } = await supabase.rpc("save_tracked_stats", {
			p_stats: payload,
		});

		if (error) {
			const code = String((error as { code?: string }).code ?? "");
			const message = String(error.message ?? "").toLowerCase();
			const isLegacySchema =
				["PGRST202", "PGRST204", "42883", "42703"].includes(code) ||
				/target_prefers_lower|target_value|has_target|column .*does not exist|function .*save_tracked_stats/.test(
					message,
				);
			if (!isLegacySchema) throw error;

			const legacyPayload = payload.map((row) => {
				const legacy: Record<string, unknown> = {
					name: row.name,
					unit: row.unit,
					display_order: row.display_order,
				};
				if (row.id) legacy.id = row.id;
				if (row.icon != null) legacy.icon = row.icon;
				return legacy;
			});
			const retry = await supabase.rpc("save_tracked_stats", {
				p_stats: legacyPayload,
			});
			data = retry.data;
			error = retry.error;
		}

		if (error) throw error;

		const savedById = new Map(
			payload
				.filter((row) => typeof row.id === "string")
				.map((row) => [row.id as string, row]),
		);

		return ((data as TrackedStat[] | null) ?? []).map((row, display_order) => {
			const merged = toTrackedStat(row, display_order);
			const draft =
				savedById.get(merged.id) ??
				payload[display_order] ??
				payload.find(
					(entry, index) =>
						index === display_order ||
						(typeof entry.display_order === "number" &&
							entry.display_order === display_order),
				);
			if (!draft) return merged;
			return toTrackedStat(
				{
					...merged,
					start_value: (draft.start_value as number | undefined) ?? merged.start_value,
					has_target: (draft.has_target as boolean | undefined) ?? merged.has_target,
					target_value:
						(draft.target_value as number | null | undefined) ?? merged.target_value,
					target_prefers_lower:
						(draft.target_prefers_lower as boolean | undefined) ??
						merged.target_prefers_lower,
					icon: (draft.icon as number | undefined) ?? merged.icon,
					color: (draft.color as number | undefined) ?? merged.color,
				},
				display_order,
			);
		});
	},

	/* ==================================================
		 SCHEDULE
		 RLS ensures we only touch the current user's rows.
		 Schedule uses composite PK (user_id, day_of_week),
		 so we filter on day_of_week only — user_id is
		 enforced server-side by RLS.
		 ================================================== */

	async assignTemplateToDay(dayOfWeek: number, templateId: string | null) {
		await this.assignTemplatesToDays([{ dayOfWeek, templateId }]);
	},

	async assignTemplatesToDays(
		assignments: Array<{ dayOfWeek: number; templateId: string | null }>,
	) {
		if (assignments.length === 0) return;

		const { error } = await supabase.rpc("assign_schedule_days", {
			p_assignments: assignments.map(({ dayOfWeek, templateId }) => ({
				day_of_week: dayOfWeek,
				template_id: templateId,
			})),
		});
		if (error) throw error;
	},

	/* ==================================================
		 TEMPLATE CRUD
		 ================================================== */

	async createTemplate(routineId: string, name: string): Promise<Template | null> {
		const safeName = sanitizeTemplateName(name.trim()) || "NEW TEMPLATE";

		const { data, error } = await supabase.rpc("create_template", {
			p_routine_id: routineId,
			p_name: safeName,
		});
		if (error) throw error;
		if (!data || typeof data !== "object") return null;

		const row = data as Template;
		return {
			...row,
			icon: clampItemIcon(
				typeof row.icon === "number" ? row.icon : DEFAULT_TEMPLATE_ICON,
			),
			exercises: [],
		};
	},

	async deleteTemplate(templateId: string) {
		const { error } = await supabase
			.from("templates")
			.delete()
			.eq("id", templateId);

		if (error) throw error;
	},

	async updateTemplateName(templateId: string, name: string) {
		const trimmed = sanitizeTemplateName(name.trim());
		const { error } = await supabase
			.from("templates")
			.update({ name: trimmed })
			.eq("id", templateId);
		if (error) throw error;
	},

	async updateTemplateColor(templateId: string, color: number) {
		const c = clampTemplateColor(color);
		const { error } = await supabase
			.from("templates")
			.update({ color: c })
			.eq("id", templateId);
		if (error) throw error;
	},

	async updateTemplateIcon(templateId: string, icon: number) {
		const i = clampItemIcon(icon);
		const { error } = await supabase
			.from("templates")
			.update({ icon: i })
			.eq("id", templateId);
		if (error) throw error;
	},

	async updateTemplateFields(
		templateId: string,
		fields: { name?: string; color?: number; icon?: number },
	) {
		const patch: Record<string, string | number> = {};
		if (fields.name != null) {
			patch.name = sanitizeTemplateName(fields.name.trim());
		}
		if (fields.color != null) {
			patch.color = clampTemplateColor(fields.color);
		}
		if (fields.icon != null) {
			patch.icon = clampItemIcon(fields.icon);
		}
		if (Object.keys(patch).length === 0) return;

		const { error } = await supabase
			.from("templates")
			.update(patch)
			.eq("id", templateId);
		if (error) throw error;
	},

	async updateTemplateDisplayOrders(orders: Array<{ id: string; display_order: number }>) {
		if (orders.length === 0) return;

		const { error } = await supabase.rpc("update_template_display_orders", {
			p_orders: orders,
		});
		if (error) throw error;
	},

	/**
	 * Sync template membership + exercise rows (shared library; no duplication).
	 *
	 * Multiple templates can reference the exact same exercise row (by exercise_id
	 * stored in the template's exercise_ids array). This is intentional for progressive overload:
	 * current_weight / increment live on the exercise. Finishing a workout on any
	 * template that uses the exercise will advance the shared baseline.
	 *
	 * Draft items with a real persisted UUID id → UPDATE the canonical exercise
	 * (definition + overload params), then ensure the ID is in exercise_ids.
	 * Draft items with temp- ids → INSERT new exercise row, then add the ID.
	 */
	async saveTemplateExercises(
		templateId: string,
		exercises: Array<{
			id?: string;
			name: string;
			exercise_type: "reps" | "time";
			target_sets: number;
			target_reps?: number;
			target_minutes?: number;
			target_seconds?: number;
			rest_minutes?: number;
			rest_seconds?: number;
			increment?: number;
			current_weight?: number | null;
			catalog_exercise_id?: number | null;
			catalog_muscle_ids?: number[];
			notes?: string | null;
		}>,
	): Promise<Exercise[]> {
		const validationError = validateDraftExercises(
			exercises as DraftExerciseLike[],
		);
		if (validationError) throw new Error(validationError);

		const payload = exercises.map((d) => {
			const safe = sanitizeExerciseRowForDb(d as DraftExerciseLike);
			const exerciseId = typeof d.id === "string" ? d.id : "";
			const row: Record<string, unknown> = {
				name: safe.name,
				exercise_type: safe.exercise_type,
				target_sets: safe.target_sets ?? 0,
				increment: safe.increment ?? 0,
				rest_minutes: safe.rest_minutes ?? 0,
				rest_seconds: safe.rest_seconds ?? 0,
			};
			if (isPersistedExerciseId(exerciseId)) row.id = exerciseId;
			if (safe.exercise_type === "reps") {
				row.target_reps = safe.target_reps ?? 0;
				row.current_weight = safe.current_weight ?? null;
			} else {
				row.target_minutes = safe.target_minutes ?? 0;
				row.target_seconds = safe.target_seconds ?? 0;
			}
			if (
				typeof d.catalog_exercise_id === "number" &&
				Number.isInteger(d.catalog_exercise_id)
			) {
				row.catalog_exercise_id = d.catalog_exercise_id;
			}
			if (Array.isArray(d.catalog_muscle_ids)) {
				row.catalog_muscle_ids = [
					...new Set(
						d.catalog_muscle_ids.filter(
							(id) => typeof id === "number" && Number.isInteger(id),
						),
					),
				];
			}
			if (typeof d.notes === "string") {
				row.notes = d.notes.trim().slice(0, 2000) || null;
			}
			return row;
		});

		const { data, error } = await supabase.rpc("save_template_exercises", {
			p_template_id: templateId,
			p_exercises: payload,
		});
		if (error) throw error;

		return ((data as Exercise[] | null) ?? []).map((row, display_order) => ({
			...normalizeExerciseFromDb(row),
			display_order: row.display_order ?? display_order,
		}));
	},

	/* ==================================================
		 EXERCISES
		 ================================================== */

	async deleteExercise(exerciseId: string) {
		const { error } = await supabase
			.from("exercises")
			.delete()
			.eq("id", exerciseId);

		if (error) throw error;
	},

	async saveExerciseBaseline(exerciseId: string, initialWeight: number) {
		initialWeight = sanitizeBaseKg(initialWeight);
		const { error } = await supabase
			.from("exercises")
			.update({ current_weight: initialWeight })
			.eq("id", exerciseId);

		if (error) throw error;
	},

	async updateExerciseOrder(templateId: string, exercises: Exercise[]) {
		if (exercises.length === 0) {
			const { error } = await supabase
				.from("templates")
				.update({ exercise_ids: [] })
				.eq("id", templateId);
			if (error) throw error;
			return;
		}

		const exerciseIds = exercises.map((e) => e.id);
		const { error } = await supabase
			.from("templates")
			.update({ exercise_ids: exerciseIds })
			.eq("id", templateId);
		if (error) throw error;
	},

	/* ==================================================
		 HISTORY
		 ================================================== */

	async skipWorkout(
		templateId: string | null,
		templateName?: string | null,
	): Promise<WorkoutHistory> {
		const { data, error } = await supabase.rpc("skip_workout_log", {
			p_workout_date: todayDateString(),
			p_template_id: templateId,
			p_template_name: templateName,
		});
		if (error) throw error;
		return data as WorkoutHistory;
	},

	async submitWorkoutSession(
		template: Template,
		performanceSnapshot: PerformanceSnapshot,
		durationSeconds: number,
	): Promise<CompleteWorkoutResult> {
		const duration = normalizeCompletedWorkoutDuration(durationSeconds);
		const times = performanceSnapshot.times ?? {};

		const { data, error } = await supabase.rpc("complete_workout_session", {
			p_workout_date: todayDateString(),
			p_template_id: template.id,
			p_template_name: template.name,
			p_duration_seconds: duration,
			p_reps: performanceSnapshot.reps ?? {},
			p_times: performanceTimesToSeconds(times),
			p_exercises: template.exercises.map((ex) => ({
				id: ex.id,
				name: ex.name,
				exercise_type: ex.exercise_type,
				target_sets: ex.target_sets,
				target_reps: ex.exercise_type === "reps" ? ex.target_reps : null,
				target_minutes: ex.exercise_type === "time" ? ex.target_minutes : null,
				target_seconds: ex.exercise_type === "time" ? ex.target_seconds : null,
				rest_minutes: ex.rest_minutes ?? 0,
				rest_seconds: ex.rest_seconds ?? 0,
				increment: ex.increment,
				current_weight: ex.current_weight,
				use_override: !!ex.override,
			})),
		});
		if (error) throw error;

		const row = data as {
			workout: WorkoutHistory;
			updated_exercises: Array<{ id: string; current_weight: number | null }>;
		};

		return {
			workout: row.workout,
			updatedExercises: row.updated_exercises ?? [],
		};
	},

	/** Autosave reps/times while a workout is in progress (one row per day). */
	async saveWorkoutProgress(
		template: Template,
		performanceSnapshot: PerformanceSnapshot,
		elapsedSeconds: number,
		startedAtMs: number,
	): Promise<WorkoutHistory> {
		const elapsed = Math.max(0, Math.round(elapsedSeconds));
		const perfMaps: PerformanceSnapshot = stripNullishJson({
			reps: performanceSnapshot.reps ?? {},
			times: performanceSnapshot.times ?? {},
			started_at: startedAtMs,
			duration_seconds: elapsed,
		});

		const { data, error } = await supabase.rpc("save_workout_progress", {
			p_workout_date: todayDateString(),
			p_template_id: template.id,
			p_template_name: template.name,
			p_performance_snapshot: perfMaps,
		});
		if (error) throw error;
		return data as WorkoutHistory;
	},

	async deleteWorkoutLog(dateStr?: string) {
		const { error } = await supabase.rpc("delete_workout_log", {
			p_workout_date: dateStr ?? todayDateString(),
		});
		if (error) throw error;
	},

	async logRestForDate(dateStr: string) {
		const uid = await requireUserId();
		const { error } = await supabase.from("workout_history").insert({
			user_id: uid,
			workout_date: dateStr,
			template_id: null,
			template_name_snapshot: null,
			workout_status: WORKOUT_STATUS.rest,
			is_skipped: false,
			duration_seconds: null,
			is_perfect_day: false,
			performance_snapshot: {},
			workout_snapshot: { is_rest: true },
		});

		if (error) throw error;
	},

	async deleteLogForDate(dateStr: string) {
		const { error } = await supabase.rpc("delete_workout_log", {
			p_workout_date: dateStr,
		});
		if (error) throw error;
	},

	async getLogForDate(dateStr: string): Promise<WorkoutHistory | null> {
		const logs = await this.getLogsForDates([dateStr]);
		return logs[dateStr] ?? null;
	},

	/** Fetch multiple day logs in a single query. */
	async getLogsForDates(
		dateStrs: string[],
	): Promise<Record<string, WorkoutHistory | null>> {
		const out: Record<string, WorkoutHistory | null> = {};
		if (dateStrs.length === 0) return out;

		const uniqueDates = [...new Set(dateStrs)];
		const { data, error } = await supabase
			.from("workout_history")
			.select("*")
			.in("workout_date", uniqueDates);

		if (error) throw error;

		for (const date of uniqueDates) {
			out[date] = null;
		}
		for (const row of (data ?? []) as WorkoutHistory[]) {
			out[row.workout_date] = row;
		}
		return out;
	},

	/* ==================================================
		 STATS / ANALYTICS
		 ================================================== */

	/** Returns workout history for the last N days, newest first. */
	async getRecentHistory(days = 30): Promise<WorkoutHistory[]> {
		const since = new Date();
		since.setDate(since.getDate() - days);

		const { data, error } = await supabase
			.from("workout_history")
			.select("*")
			.gte("workout_date", localDateString(since))
			.order("workout_date", { ascending: false });

		if (error) throw error;
		return (data as WorkoutHistory[]) ?? [];
	},

	/** Returns all sessions where is_perfect_day = true. */
	async getPerfectDays(): Promise<WorkoutHistory[]> {
		const { data, error } = await supabase
			.from("workout_history")
			.select("*")
			.eq("is_perfect_day", true)
			.order("workout_date", { ascending: false });

		if (error) throw error;
		return (data as WorkoutHistory[]) ?? [];
	},

	/** Returns the best (heaviest) weight ever logged for a given exercise id. */
	async getExercisePersonalBest(exerciseId: string): Promise<number> {
		return getExerciseAllTimeBest(exerciseId);
	},

	/** Newest-first page of workout history, for the full archive view. */
	async getHistoryPage(beforeDate?: string | null, limit = 40): Promise<WorkoutHistory[]> {
		const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
		let query = supabase
			.from("workout_history")
			.select("*")
			.order("workout_date", { ascending: false })
			.limit(safeLimit);
		if (beforeDate) query = query.lt("workout_date", beforeDate);
		const { data, error } = await query;
		if (error) throw error;
		return (data as WorkoutHistory[]) ?? [];
	},

	/* ==================================================
		 EXERCISE CATALOG (wger; public read-only)
		 ================================================== */

	async getCatalogFilters(): Promise<{
		categories: CatalogCategory[];
		equipment: CatalogEquipment[];
		muscles: CatalogMuscle[];
	}> {
		const [categoriesRes, equipmentRes, musclesRes] = await Promise.all([
			supabase.from("wger_categories").select("id, name").order("name"),
			supabase.from("wger_equipment").select("id, name").order("name"),
			supabase.from("wger_muscles").select("id, name, name_en, is_front").order("name"),
		]);
		if (categoriesRes.error) throw categoriesRes.error;
		if (equipmentRes.error) throw equipmentRes.error;
		if (musclesRes.error) throw musclesRes.error;
		return {
			categories: (categoriesRes.data ?? []) as CatalogCategory[],
			equipment: (equipmentRes.data ?? []) as CatalogEquipment[],
			muscles: (musclesRes.data ?? []) as CatalogMuscle[],
		};
	},

	async searchCatalog(
		filters: CatalogFilters = {},
	): Promise<{ exercises: CatalogExerciseSummary[]; total: number }> {
		const limit = Math.max(1, Math.min(60, filters.limit ?? 30));
		const offset = Math.max(0, filters.offset ?? 0);
		const equipmentJoin = filters.equipmentId
			? "wger_exercise_equipment!inner"
			: "wger_exercise_equipment";
		const muscleJoin = filters.muscleId
			? "wger_exercise_muscles!inner"
			: "wger_exercise_muscles";
		const select = [
			"id, name, category_id, license, license_author",
			"wger_categories ( name )",
			`${equipmentJoin} ( equipment_id, wger_equipment ( id, name ) )`,
			`${muscleJoin} ( muscle_id, is_primary, wger_muscles ( id, name, name_en, is_front ) )`,
		].join(", ");

		let query = supabase
			.from("wger_exercises")
			.select(select, { count: "exact" })
			.order("name")
			.range(offset, offset + limit - 1);

		const search = (filters.query ?? "").trim().replace(/[%_\\]/g, " ").slice(0, 80);
		if (search) query = query.ilike("name", `%${search}%`);
		if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
		if (filters.equipmentId) {
			query = query.eq("wger_exercise_equipment.equipment_id", filters.equipmentId);
		}
		if (filters.muscleId) {
			query = query.eq("wger_exercise_muscles.muscle_id", filters.muscleId);
		}

		const { data, error, count } = await query;
		if (error) throw error;

		const exercises = ((data ?? []) as any[]).map((row) =>
			catalogSummaryFromRow(row),
		);
		return { exercises, total: count ?? exercises.length };
	},

	async getCatalogExercise(id: number): Promise<CatalogExerciseDetail | null> {
		const { data, error } = await supabase
			.from("wger_exercises")
			.select(
				"id, uuid, name, description, category_id, license, license_author, license_url, wger_categories ( name ), wger_exercise_equipment ( equipment_id, wger_equipment ( id, name ) ), wger_exercise_muscles ( muscle_id, is_primary, wger_muscles ( id, name, name_en, is_front ) )",
			)
			.eq("id", id)
			.maybeSingle();
		if (error) throw error;
		if (!data) return null;
		const summary = catalogSummaryFromRow(data as any);
		return {
			...summary,
			uuid: ((data as any).uuid as string | null) ?? null,
			description: ((data as any).description as string | null) ?? "",
			license_url: ((data as any).license_url as string | null) ?? null,
		};
	},

	/* ==================================================
		 ROUTINES (multiple per user, one active)
		 Owned routines are editable; bookmarked ones are read-only live links.
		 ================================================== */

	/** List all routines owned by the current user. */
	async getMyRoutines(): Promise<Routine[]> {
		const uid = await requireUserId();
		const { data, error } = await supabase
			.from("routines")
			.select(
				"id, user_id, name, created_at, display_order, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots, templates ( id )",
			)
			.eq("user_id", uid)
			.order("display_order")
			.order("created_at");
		if (error) throw error;
		return ((data ?? []) as any[]).map((r: any) => ({
				id: r.id,
				user_id: r.user_id,
				name: r.name,
				created_at: r.created_at,
				display_order: r.display_order ?? 0,
				template_count: Array.isArray(r.templates) ? r.templates.length : 0,
				schedule_mode: r.schedule_mode ?? "weekly",
				cycle_length: r.cycle_length ?? 7,
				cycle_anchor_date: r.cycle_anchor_date,
				cycle_slots: Array.isArray(r.cycle_slots) ? r.cycle_slots : [],
			}));
	},

	/**
	 * Full user list: owned routines + bookmarked (read-only) routines.
	 * Bookmarks live-update from the source owner's routine.
	 */
	async getUserRoutineList(): Promise<UserRoutineListItem[]> {
		const uid = await requireUserId();
		const [owned, bmRes, usersRes] = await Promise.all([
			this.getMyRoutines(),
			supabase
				.from("routine_bookmarks")
				.select("id, user_id, routine_id, created_at, display_order")
				.eq("user_id", uid)
				.order("display_order")
				.order("created_at"),
			supabase.from("usernames").select("username, user_id, avatar_seed"),
		]);
		if (bmRes.error) throw bmRes.error;
		if (usersRes.error) throw usersRes.error;

		const bookmarks = (bmRes.data ?? []) as RoutineBookmark[];
		const userMap = new Map(
			((usersRes.data ?? []) as UserProfileRow[]).map((u) => [u.user_id, u]),
		);

		const ownedItems: UserRoutineListItem[] = owned.map((r) => ({
			...r,
			source: "owned" as const,
			is_readonly: false,
			owner_username: userMap.get(r.user_id)?.username,
			owner_avatar_seed: userMap.get(r.user_id)?.avatar_seed ?? null,
		}));

		let bookmarkedItems: UserRoutineListItem[] = [];
		if (bookmarks.length > 0) {
			const ids = bookmarks.map((b) => b.routine_id);
			const { data: remoteRoutines, error: rrErr } = await supabase
				.from("routines")
				.select("id, user_id, name, created_at, display_order, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots, templates ( id, exercise_ids )")
				.in("id", ids);
			if (rrErr) throw rrErr;
			const rMap = new Map(((remoteRoutines ?? []) as any[]).map((r) => [r.id, r]));

			const items: UserRoutineListItem[] = [];
			for (const bm of bookmarks) {
				const r = rMap.get(bm.routine_id);
				if (!r) continue;
				const owner = userMap.get(r.user_id);
				const tpls = Array.isArray(r.templates) ? r.templates : [];
				const tplCount = tpls.length;
				items.push({
					id: r.id as string,
					user_id: r.user_id as string,
					name: r.name as string,
					created_at: r.created_at as string,
					display_order: bm.display_order ?? 0,
					template_count: tplCount,
					schedule_mode: r.schedule_mode ?? "weekly",
					cycle_length: r.cycle_length ?? 7,
					cycle_anchor_date: r.cycle_anchor_date,
					cycle_slots: Array.isArray(r.cycle_slots) ? r.cycle_slots : [],
					source: "bookmarked",
					is_readonly: true,
					owner_username: owner?.username ?? "unknown",
					owner_avatar_seed: owner?.avatar_seed ?? null,
					bookmark_id: bm.id,
				});
			}
			bookmarkedItems = items;
		}

		// Owned first (display_order), then bookmarks (display_order)
		return [...ownedItems, ...bookmarkedItems];
	},

	/** Create a new routine with the given name (appended at end of list). */
	async createRoutine(name: string): Promise<Routine> {
		const safeName = sanitizeTemplateName(name.trim()) || "NEW ROUTINE";
		const uid = await requireUserId();
		const { data: maxRow } = await supabase
			.from("routines")
			.select("display_order")
			.eq("user_id", uid)
			.order("display_order", { ascending: false })
			.limit(1)
			.maybeSingle();
		const nextOrder = (maxRow?.display_order ?? -1) + 1;
		const { data, error } = await supabase
			.from("routines")
			.insert({ user_id: uid, name: safeName, display_order: nextOrder })
			.select("id, user_id, name, created_at, display_order")
			.single();
		if (error) throw error;

		// Seed empty 7-day schedule; roll the routine back if the seed cannot be written.
		const days = Array.from({ length: 7 }, (_, dow) => ({
			routine_id: data.id,
			day_of_week: dow,
			template_id: null,
		}));
		const { error: seedErr } = await supabase.from("routine_schedules").insert(days);
		if (seedErr) {
			await supabase.from("routines").delete().eq("id", data.id).eq("user_id", uid);
			throw seedErr;
		}

		return { ...data, template_count: 0 } as Routine;
	},

	/** Rename a routine (owned only — RLS enforces). */
	async renameRoutine(routineId: string, name: string): Promise<void> {
		const safeName = sanitizeTemplateName(name.trim()) || "ROUTINE";
		const { error } = await supabase
			.from("routines")
			.update({ name: safeName })
			.eq("id", routineId);
		if (error) throw error;
	},

	/**
	 * Delete an owned routine. Bookmarks of others cascade via FK.
	 * Does NOT delete templates/exercises (shared across user's routines).
	 * Bookmarked entries must use removeBookmarkFromList instead.
	 */
	async deleteRoutine(routineId: string): Promise<void> {
		const { error } = await supabase.rpc("delete_own_routine", {
			p_routine_id: routineId,
		});
		if (error) throw error;
	},

	/**
	 * Set the active routine (owned or bookmarked). Materializes plan into schedule.
	 * For bookmarked routines this is a live snapshot; resync on load.
	 */
	async setActiveRoutine(routineId: string | null): Promise<void> {
		const { error } = await supabase.rpc("set_active_routine", {
			p_routine_id: routineId,
		});
		if (error) throw error;
	},

	async getRoutineSchedule(routineId: string): Promise<RoutineSchedule[]> {
		const { data, error } = await supabase
			.from("routine_schedules")
			.select("routine_id, day_of_week, template_id")
			.eq("routine_id", routineId)
			.order("day_of_week");
		if (error) throw error;
		return (data ?? []) as RoutineSchedule[];
	},

	/**
	 * Save weekly assignments to an owned routine.
	 * Always stores all 7 days (null for unassigned). Also mirrors to schedule if active.
	 */
	async saveRoutineSchedule(
		routineId: string,
		schedule: Array<{ day_of_week: number; template_id: string | null }>,
	): Promise<void> {
		const uid = await requireUserId();
		// Refuse if not owned
		const { data: ownerRow, error: ownErr } = await supabase
			.from("routines")
			.select("user_id")
			.eq("id", routineId)
			.maybeSingle();
		if (ownErr) throw ownErr;
		if (!ownerRow || ownerRow.user_id !== uid) {
			throw new Error("Bookmarked routines are read-only. Copy the routine to edit it.");
		}

		const byDay = new Map<number, string | null>();
		for (const s of schedule) {
			byDay.set(s.day_of_week, s.template_id);
		}
		const allDays: Array<{ routine_id: string; day_of_week: number; template_id: string | null }> = [];
		for (let dow = 0; dow < 7; dow++) {
			allDays.push({
				routine_id: routineId,
				day_of_week: dow,
				template_id: byDay.has(dow) ? byDay.get(dow)! : null,
			});
		}
		const { error } = await supabase.rpc("save_routine_schedule", {
			p_routine_id: routineId,
			p_schedule: allDays.map(({ day_of_week, template_id }) => ({
				day_of_week,
				template_id,
			})),
		});
		if (error) throw error;
	},

	/**
	 * Switch an owned routine to a repeating cycle (not tied to weekdays).
	 * `slots[i]` is the template for day i; null = rest.
	 */
	async saveRoutineCycle(
		routineId: string,
		length: number,
		anchorDate: string,
		slots: Array<string | null>,
	): Promise<void> {
		const safeLength = Math.max(1, Math.min(28, Math.round(length) || 7));
		const normalized = Array.from({ length: safeLength }, (_, i) => {
			const value = slots[i];
			return typeof value === "string" && value ? value : null;
		});
		const { error } = await supabase.rpc("save_routine_cycle", {
			p_routine_id: routineId,
			p_length: safeLength,
			p_anchor_date: anchorDate,
			p_slots: normalized,
		});
		if (error) throw error;
	},

	/** Return an owned routine to the normal weekly weekday schedule. */
	async resetRoutineToWeekly(routineId: string): Promise<void> {
		const { error } = await supabase.rpc("reset_routine_to_weekly", {
			p_routine_id: routineId,
		});
		if (error) throw error;
	},

	/** Persist per-day overrides + superset links for an owned template. */
	async saveTemplateOverrides(
		templateId: string,
		overrides: Record<string, ExerciseOverride>,
		supersetWithNext: string[] = [],
	): Promise<void> {
		const clean: Record<string, ExerciseOverride> = {};
		for (const [exerciseId, raw] of Object.entries(overrides ?? {})) {
			if (!isPersistedExerciseId(exerciseId) || !raw) continue;
			const entry: ExerciseOverride = {};
			const numeric = [
				"target_sets",
				"target_reps",
				"target_minutes",
				"target_seconds",
				"rest_minutes",
				"rest_seconds",
				"increment",
			] as const;
			for (const key of numeric) {
				const value = raw[key];
				if (typeof value === "number" && Number.isFinite(value)) {
					entry[key] = Math.max(0, value);
				}
			}
			if (raw.current_weight === null) {
				entry.current_weight = null;
			} else if (
				typeof raw.current_weight === "number" &&
				Number.isFinite(raw.current_weight)
			) {
				entry.current_weight = Math.max(0, raw.current_weight);
			}
			if (Object.keys(entry).length > 0) clean[exerciseId] = entry;
		}
		const supersets = [...new Set(supersetWithNext.filter(isPersistedExerciseId))];
		const { error } = await supabase
			.from("templates")
			.update({
				exercise_overrides: clean,
				superset_with_next: supersets,
			})
			.eq("id", templateId);
		if (error) throw error;
	},

	/** Advance the stored current_weight of day-specific overrides after a workout. */
	async advanceTemplateOverrideWeights(
		templateId: string,
		updates: Array<{ exercise_id: string; current_weight: number | null }>,
	): Promise<void> {
		if (updates.length === 0) return;
		const { data, error } = await supabase
			.from("templates")
			.select("exercise_overrides")
			.eq("id", templateId)
			.maybeSingle();
		if (error) throw error;
		const current =
			data?.exercise_overrides && typeof data.exercise_overrides === "object"
				? ({ ...(data.exercise_overrides as Record<string, ExerciseOverride>) })
				: {};
		let changed = false;
		for (const update of updates) {
			const existing = current[update.exercise_id];
			if (!existing) continue;
			current[update.exercise_id] = {
				...existing,
				current_weight: update.current_weight,
			};
			changed = true;
		}
		if (!changed) return;
		const { error: saveErr } = await supabase
			.from("templates")
			.update({ exercise_overrides: current })
			.eq("id", templateId);
		if (saveErr) throw saveErr;
	},

	/** Save the user's app preferences (theme, haptics, reminders, ...). */
	async savePreferences(preferences: AppPreferences): Promise<void> {
		const { error } = await supabase.rpc("save_user_preferences", {
			p_preferences: preferences ?? {},
		});
		if (error) throw error;
	},

	/** Persist reordered display_orders for owned routines only (safe UPDATEs, no upsert). */
	async updateRoutineDisplayOrders(orders: Array<{ id: string; display_order: number }>): Promise<void> {
		const uid = await requireUserId();
		const results = await Promise.all(
			orders.map((o) =>
				supabase
					.from("routines")
					.update({ display_order: o.display_order })
					.eq("id", o.id)
					.eq("user_id", uid),
			),
		);
		const firstErr = results.find((r) => r.error)?.error;
		if (firstErr) throw firstErr;
	},

	/** Get the active routine id for the current user. */
	async getActiveRoutineId(): Promise<string | null> {
		const uid = await requireUserId();
		const { data, error } = await supabase
			.from("usernames")
			.select("active_routine_id")
			.eq("user_id", uid)
			.maybeSingle();
		if (error) throw error;
		return (data?.active_routine_id as string) ?? null;
	},

	/** Whether the given routine is owned by the current user. */
	async isRoutineOwned(routineId: string): Promise<boolean> {
		const uid = await requireUserId();
		const { data, error } = await supabase
			.from("routines")
			.select("user_id")
			.eq("id", routineId)
			.maybeSingle();
		if (error) throw error;
		return !!data && data.user_id === uid;
	},

	/** List all users and their routines (for discovery browsing). */
	async getAllUsersAndRoutines(): Promise<RoutineWithOwner[]> {
		const [routinesRes, usersRes] = await Promise.all([
			supabase
				.from("routines")
				.select("id, user_id, name, created_at, display_order, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots, templates ( id, exercise_ids ), routine_schedules ( day_of_week, template_id )")
				.order("created_at"),
			supabase.from("usernames").select("username, user_id, avatar_seed"),
		]);
		if (routinesRes.error) throw routinesRes.error;
		if (usersRes.error) throw usersRes.error;

		const userMap = new Map(
			((usersRes.data ?? []) as UserProfileRow[]).map((u) => [u.user_id, u]),
		);

		return ((routinesRes.data ?? []) as any[])
			.filter((row) => {
				const tpls = Array.isArray(row.templates) ? row.templates : [];
				return tpls.some((t: any) => Array.isArray(t.exercise_ids) && t.exercise_ids.length > 0);
			})
			.map((row) => {
				const owner = userMap.get(row.user_id);
				const sched = Array.isArray(row.routine_schedules) ? row.routine_schedules : [];
				const tpls = Array.isArray(row.templates) ? row.templates : [];
				const tplCount = tpls.length;
				return {
					id: row.id,
					user_id: row.user_id,
					name: row.name,
					created_at: row.created_at,
					display_order: row.display_order ?? 0,
					schedule_mode: row.schedule_mode ?? "weekly",
					cycle_length: row.cycle_length ?? 7,
					cycle_anchor_date: row.cycle_anchor_date,
					cycle_slots: Array.isArray(row.cycle_slots) ? row.cycle_slots : [],
					owner_username: owner?.username ?? "unknown",
					owner_avatar_seed: owner?.avatar_seed ?? null,
					template_count: tplCount,
					schedule: (sched as any[]).map((s: any) => ({
						day_of_week: s.day_of_week,
						template_id: s.template_id,
					})),
				};
			});
	},

	/** Bookmark someone else's routine (read-only live link in your list). */
	async bookmarkRoutine(routineId: string): Promise<RoutineBookmark> {
		const { data, error } = await supabase.rpc("bookmark_routine", {
			p_routine_id: routineId,
		});
		if (error) throw error;
		return data as RoutineBookmark;
	},

	/** Remove a bookmark by bookmark row id (legacy). Prefer removeBookmarkFromList. */
	async unbookmarkRoutine(bookmarkId: string): Promise<void> {
		const { error } = await supabase
			.from("routine_bookmarks")
			.delete()
			.eq("id", bookmarkId);
		if (error) throw error;
	},

	/**
	 * Remove a bookmarked routine from the user's list only.
	 * Never deletes the source routine. Clears active if it was that routine.
	 */
	async removeBookmarkFromList(routineId: string): Promise<void> {
		const { error } = await supabase.rpc("unbookmark_routine", {
			p_routine_id: routineId,
		});
		if (error) throw error;
	},

	/** Get all bookmarks for the current user, with routine + owner info. */
	async getUserBookmarks(): Promise<
		Array<RoutineBookmark & { routine_name: string; routine_owner_id: string; owner_username: string; owner_avatar_seed: string | null }>
	> {
		const uid = await requireUserId();
		const [bmRes, routinesRes, usersRes] = await Promise.all([
			supabase
				.from("routine_bookmarks")
				.select("id, user_id, routine_id, created_at, display_order")
				.eq("user_id", uid)
				.order("display_order"),
			supabase.from("routines").select("id, name, user_id"),
			supabase.from("usernames").select("username, user_id, avatar_seed"),
		]);
		if (bmRes.error) throw bmRes.error;
		if (routinesRes.error) throw routinesRes.error;
		if (usersRes.error) throw usersRes.error;

		const routineMap = new Map(
			((routinesRes.data ?? []) as Routine[]).map((r) => [r.id, r]),
		);
		const userMap = new Map(
			((usersRes.data ?? []) as UserProfileRow[]).map((u) => [u.user_id, u]),
		);

		return ((bmRes.data ?? []) as RoutineBookmark[]).map((bm) => {
			const routine = routineMap.get(bm.routine_id);
			const owner = routine ? userMap.get(routine.user_id) : null;
			return {
				...bm,
				routine_name: routine?.name ?? "unknown",
				routine_owner_id: routine?.user_id ?? "",
				owner_username: owner?.username ?? "unknown",
				owner_avatar_seed: owner?.avatar_seed ?? null,
			};
		});
	},

	/**
	 * Deep copy a routine into the current user's account.
	 * Used for community copy and for duplicating an owned routine.
	 *
	 * Runs as one server-side transaction so a failure cannot leave orphan routines,
	 * templates or exercises behind. Copies every template in the routine (not only
	 * those currently assigned to a day), cloning exercises once each.
	 */
	async copyRoutine(sourceRoutineId: string): Promise<Routine & { source_name: string; source_username: string }> {
		const { data, error } = await supabase.rpc("copy_routine", {
			p_source_routine_id: sourceRoutineId,
		});
		if (error) throw error;
		if (!data) throw new Error("Copy failed");
		return data as Routine & { source_name: string; source_username: string };
	},

	/* ==================================================
		 ROUTINE JSON EXPORT / IMPORT (schema v2)
		 Legacy CSV still accepted on import only.
		 ================================================== */

	/**
	 * Build a pretty-printed lift-tracker routine JSON file.
	 * Round-trippable via importRoutineFromText.
	 */
	async exportRoutineToJson(routineId: string): Promise<{ json: string; filename: string }> {
		const uid = await requireUserId();
		const { data: routine, error: rErr } = await supabase
			.from("routines")
			.select(
				"id, user_id, name, created_at, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots",
			)
			.eq("id", routineId)
			.single();
		if (rErr) throw rErr;

		const { data: ownerRow } = await supabase
			.from("usernames")
			.select("username")
			.eq("user_id", routine.user_id)
			.maybeSingle();
		const ownerUsername = (ownerRow?.username as string) ?? null;

		const plan = await this.getRoutineSchedule(routineId);
		const byDay = new Map<number, string | null>();
		for (let d = 0; d < 7; d++) byDay.set(d, null);
		for (const s of plan) byDay.set(s.day_of_week, s.template_id);

		type ExRow = {
			id: string;
			name: string;
			exercise_type: "reps" | "time";
			target_sets: number;
			target_reps: number | null;
			target_minutes: number | null;
			target_seconds: number | null;
			rest_minutes: number;
			rest_seconds: number;
			increment: number;
			current_weight: number | null;
			display_order: number;
			catalog_exercise_id?: number | null;
			catalog_muscle_ids?: number[];
			notes?: string | null;
			override?: ExerciseOverride;
			superset_with_next?: boolean;
		};
		type TplPack = {
			id: string;
			key: string;
			name: string;
			color: number;
			icon: number;
			exercises: ExRow[];
		};

		const packs: TplPack[] = [];
		const assignedIds = [
			...new Set([...byDay.values()].filter((id): id is string => !!id)),
		];
		const cycleSlotsRaw = Array.isArray(routine.cycle_slots) ? routine.cycle_slots : [];
		const cycleAssignedIds = cycleSlotsRaw.filter(
			(id): id is string => typeof id === "string" && !!id,
		);
		const templateSelect =
			"id, name, color, icon, exercise_ids, display_order, exercise_overrides, superset_with_next";
		const { data: routineTemplates, error: tErr } = await supabase
			.from("templates")
			.select(templateSelect)
			.eq("routine_id", routineId)
			.order("display_order");
		if (tErr) throw tErr;

		let templateRows = (routineTemplates ?? []) as Array<Record<string, any>>;
		const knownTemplateIds = new Set(templateRows.map((t) => t.id as string));
		const missingAssigned = [...new Set([...assignedIds, ...cycleAssignedIds])].filter(
			(id) => !knownTemplateIds.has(id),
		);
		if (missingAssigned.length > 0) {
			const { data: extraTemplates, error: extraErr } = await supabase
				.from("templates")
				.select(templateSelect)
				.in("id", missingAssigned);
			if (extraErr) throw extraErr;
			templateRows = [...templateRows, ...((extraTemplates ?? []) as Array<Record<string, any>>)];
		}

		for (const t of templateRows) {
			const exIds = Array.isArray(t.exercise_ids) ? t.exercise_ids : [];
			const exs = await fetchExercisesForIds(exIds);
			const overrides =
				t.exercise_overrides && typeof t.exercise_overrides === "object"
					? (t.exercise_overrides as Record<string, ExerciseOverride>)
					: {};
			const supersetIds = new Set(
				Array.isArray(t.superset_with_next)
					? (t.superset_with_next as string[])
					: [],
			);
			packs.push({
				id: t.id,
				key: `t${packs.length}`,
				name: t.name,
				color: typeof t.color === "number" ? t.color : 0,
				icon: typeof t.icon === "number" ? clampItemIcon(t.icon) : DEFAULT_TEMPLATE_ICON,
				exercises: exs.map((e, i) => ({
					id: e.id,
					name: e.name,
					exercise_type: e.exercise_type === "time" ? "time" : "reps",
					target_sets: e.target_sets ?? 0,
					target_reps: e.target_reps ?? null,
					target_minutes: e.target_minutes ?? null,
					target_seconds: e.target_seconds ?? null,
					rest_minutes: e.rest_minutes ?? 0,
					rest_seconds: e.rest_seconds ?? 0,
					increment: e.increment ?? 0,
					current_weight: e.current_weight ?? null,
					display_order: e.display_order ?? i,
					catalog_exercise_id: e.catalog_exercise_id ?? null,
					catalog_muscle_ids: e.catalog_muscle_ids ?? [],
					notes: e.notes ?? null,
					override: overrides[e.id],
					superset_with_next: supersetIds.has(e.id),
				})),
			});
		}

		const tplNameById = new Map(packs.map((p) => [p.id, p.name]));
		const tplKeyById = new Map(packs.map((p) => [p.id, p.key]));
		const week: Record<string, string | null> = {};
		const weekKeys: Record<string, string | null> = {};
		let trainingDays = 0;
		for (let d = 0; d < 7; d++) {
			const tid = byDay.get(d) ?? null;
			const tname = tid ? tplNameById.get(tid) ?? null : null;
			week[ROUTINE_WEEK_KEYS[d]] = tname;
			weekKeys[ROUTINE_WEEK_KEYS[d]] = tid ? tplKeyById.get(tid) ?? null : null;
			if (tname) trainingDays++;
		}

		const exerciseCount = packs.reduce((n, p) => n + p.exercises.length, 0);
		const scheduleMode = routine.schedule_mode === "cycle" ? "cycle" : "weekly";
		const cycleLength =
			scheduleMode === "cycle"
				? Math.max(1, Math.min(28, Number(routine.cycle_length) || cycleSlotsRaw.length || 7))
				: 7;
		const cycleSlots =
			scheduleMode === "cycle"
				? Array.from({ length: cycleLength }, (_, i) => {
						const tid = cycleSlotsRaw[i];
						return typeof tid === "string" && tid ? tplKeyById.get(tid) ?? null : null;
					})
				: null;
		const doc: LiftRoutineFileV2 = {
			format: LIFT_ROUTINE_FORMAT,
			schemaVersion: LIFT_ROUTINE_SCHEMA_VERSION,
			meta: {
				name: routine.name,
				exportedAt: new Date().toISOString(),
				appVersion: APP_VERSION,
				author: {
					username: ownerUsername,
					userId: routine.user_id,
				},
				source: {
					routineId: routine.id,
					ownerUsername,
					ownerUserId: routine.user_id,
					exportedByUserId: uid,
				},
				stats: {
					templates: packs.length,
					exercises: exerciseCount,
					trainingDays,
					restDays: 7 - trainingDays,
				},
			},
			schedule: {
				mode: scheduleMode,
				cycleLength,
				anchorDate: routine.cycle_anchor_date ?? null,
				slots: cycleSlots,
			},
			week,
			weekKeys,
			templates: packs.map((pack) => {
				const colorIndex = clampTemplateColor(pack.color ?? 0);
				const ordered = pack.exercises
					.slice()
					.sort((a, b) => a.display_order - b.display_order);
				return {
					key: pack.key,
					name: pack.name,
					color: {
						index: colorIndex,
						hex: getTemplateColor(colorIndex).toUpperCase(),
					},
					icon: clampItemIcon(pack.icon ?? DEFAULT_TEMPLATE_ICON),
					exercises: ordered.map((ex) => {
						const json = exerciseToJsonExport(ex);
						if (ex.override && Object.keys(ex.override).length > 0) {
							json.override = exerciseOverrideToJsonExport(ex.override);
						}
						if (ex.superset_with_next) json.supersetWithNext = true;
						return json;
					}),
				};
			}),
		};

		const json = `${JSON.stringify(doc, null, 2)}\n`;
		const ownerPart = ownerUsername ? `-${ownerUsername}` : "";
		const slug =
			`${routine.name}${ownerPart}`
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 48) || "routine";
		const date = localDateString(new Date());
		return { json, filename: `lift-tracker-${slug}-${date}.lift.json` };
	},

	/**
	 * Import a routine file (JSON v2 preferred; legacy CSV still accepted).
	 * Batch-inserts templates + exercises like copyRoutine.
	 */
	async importRoutineFromText(fileText: string): Promise<Routine> {
		const uid = await requireUserId();
		const text = String(fileText ?? "").replace(/^\uFEFF/, "").trim();
		if (!text) throw new Error("File is empty.");

		const parsed = looksLikeRoutineJson(text)
			? parseRoutineExportJson(text)
			: parseRoutineExportCsv(text);

		if (parsed.templates.length === 0 && !parsed.schedule.some((s) => s.template_name)) {
			throw new Error("Could not parse routine file — no templates found.");
		}

		return createOwnedRoutineFromParsed(uid, parsed);
	},

	/** @deprecated Use importRoutineFromText — kept as alias for older call sites. */
	async importRoutineFromCsv(csvText: string): Promise<Routine> {
		return this.importRoutineFromText(csvText);
	},
};

const LIFT_ROUTINE_FORMAT = "lift-tracker-routine" as const;
const LIFT_ROUTINE_SCHEMA_VERSION = 3;
const ROUTINE_WEEK_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type LiftRoutineFileV2 = {
	format: typeof LIFT_ROUTINE_FORMAT;
	schemaVersion: number;
	meta: {
		name: string;
		exportedAt: string;
		appVersion: string;
		author: { username: string | null; userId: string };
		source: {
			routineId: string;
			ownerUsername: string | null;
			ownerUserId: string;
			exportedByUserId: string;
		};
		stats: {
			templates: number;
			exercises: number;
			trainingDays: number;
			restDays: number;
		};
	};
	schedule?: {
		mode: "weekly" | "cycle";
		cycleLength?: number;
		anchorDate?: string | null;
		slots?: Array<string | null> | null;
	};
	week: Record<string, string | null>;
	weekKeys?: Record<string, string | null>;
	templates: Array<{
		key?: string;
		name: string;
		color: { index: number; hex: string };
		icon: number;
		exercises: Array<Record<string, unknown>>;
	}>;
};

function exerciseToJsonExport(ex: {
	name: string;
	exercise_type: "reps" | "time";
	target_sets: number;
	target_reps: number | null;
	target_minutes: number | null;
	target_seconds: number | null;
	rest_minutes: number;
	rest_seconds: number;
	increment: number;
	current_weight: number | null;
	catalog_exercise_id?: number | null;
	catalog_muscle_ids?: number[];
	notes?: string | null;
}): Record<string, unknown> {
	const restSec =
		Math.max(0, Math.floor(ex.rest_minutes ?? 0)) * 60 +
		Math.max(0, Math.floor(ex.rest_seconds ?? 0));
	const provenance: Record<string, unknown> = {};
	if (typeof ex.catalog_exercise_id === "number") provenance.catalogId = ex.catalog_exercise_id;
	if (Array.isArray(ex.catalog_muscle_ids) && ex.catalog_muscle_ids.length > 0) {
		provenance.muscleIds = ex.catalog_muscle_ids;
	}
	if (typeof ex.notes === "string" && ex.notes.trim()) provenance.notes = ex.notes;
	if (ex.exercise_type === "time") {
		const durationSec =
			Math.max(0, Math.floor(ex.target_minutes ?? 0)) * 60 +
			Math.max(0, Math.floor(ex.target_seconds ?? 0));
		return {
			name: ex.name,
			type: "time",
			sets: ex.target_sets ?? 0,
			durationSec,
			progressSec: ex.increment ?? 0,
			restSec,
			...provenance,
		};
	}
	return {
		name: ex.name,
		type: "reps",
		sets: ex.target_sets ?? 0,
		reps: ex.target_reps ?? 0,
		loadKg: ex.current_weight,
		progressKg: ex.increment ?? 0,
		restSec,
		...provenance,
	};
}

/** Serialize a per-day override using the same field names as template exercises. */
function exerciseOverrideToJsonExport(override: ExerciseOverride): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (typeof override.target_sets === "number") out.sets = override.target_sets;
	if (typeof override.target_reps === "number") out.reps = override.target_reps;
	if (typeof override.target_minutes === "number" || typeof override.target_seconds === "number") {
		out.durationSec =
			Math.max(0, Math.floor(override.target_minutes ?? 0)) * 60 +
			Math.max(0, Math.floor(override.target_seconds ?? 0));
	}
	if (override.current_weight !== undefined) out.loadKg = override.current_weight;
	if (typeof override.increment === "number") out.progressKg = override.increment;
	if (typeof override.rest_minutes === "number" || typeof override.rest_seconds === "number") {
		out.restSec =
			Math.max(0, Math.floor(override.rest_minutes ?? 0)) * 60 +
			Math.max(0, Math.floor(override.rest_seconds ?? 0));
	}
	return out;
}

function looksLikeRoutineJson(text: string): boolean {
	const t = text.trimStart();
	return t.startsWith("{") || t.startsWith("[");
}

/** Persist a parsed routine export as a new owned routine (batch inserts). */
async function createOwnedRoutineFromParsed(
	uid: string,
	parsed: ParsedRoutineExport,
): Promise<Routine> {
	const nameToId = new Map<string, string>();
	const keyToId = new Map<string, string>();
	const registerName = (raw: string, id: string) => {
		const n = raw.trim();
		if (!n) return;
		nameToId.set(n, id);
		nameToId.set(n.toUpperCase(), id);
		const safe = sanitizeTemplateName(n);
		if (safe) {
			nameToId.set(safe, id);
			nameToId.set(safe.toUpperCase(), id);
		}
	};

	const insertEx: Array<Record<string, unknown>> = [];
	const insertTpls: Array<{
		id: string;
		routine_id: string;
		name: string;
		color: number;
		icon: number;
		display_order: number;
		exercise_ids: string[];
		exercise_overrides: Record<string, ExerciseOverride>;
		superset_with_next: string[];
	}> = [];

	for (const tpl of parsed.templates) {
		const newTid = crypto.randomUUID();
		const safeName = sanitizeTemplateName(tpl.name) || "TEMPLATE";
		const exIds: string[] = [];
		const overrides: Record<string, ExerciseOverride> = {};
		const supersetIds: string[] = [];
		insertTpls.push({
			id: newTid,
			routine_id: '', // set after routine is created
			name: safeName,
			color: clampTemplateColor(tpl.color ?? 0),
			icon: clampItemIcon(tpl.icon ?? DEFAULT_TEMPLATE_ICON),
			display_order: insertTpls.length,
			exercise_ids: exIds,
			exercise_overrides: overrides,
			superset_with_next: supersetIds,
		});
		registerName(tpl.name, newTid);
		registerName(safeName, newTid);
		if (tpl.key) keyToId.set(tpl.key, newTid);

		tpl.exercises.forEach((ex) => {
			const draft = coerceImportedExercise(ex);
			const safe = sanitizeExerciseRowForDb(draft);
			const newEid = crypto.randomUUID();
			const row: Record<string, unknown> = {
				id: newEid,
				user_id: uid,
				name: safe.name,
				exercise_type: safe.exercise_type,
				target_sets: safe.target_sets ?? 1,
				increment: safe.increment ?? 0,
				rest_minutes: safe.rest_minutes ?? 0,
				rest_seconds: safe.rest_seconds ?? 0,
				catalog_exercise_id: ex.catalog_exercise_id ?? null,
				catalog_muscle_ids: ex.catalog_muscle_ids ?? [],
				notes: ex.notes ?? null,
			};
			if (safe.exercise_type === "reps") {
				row.target_reps = safe.target_reps ?? DEFAULT_TARGET_REPS;
				row.current_weight = safe.current_weight ?? null;
			} else {
				row.target_minutes = safe.target_minutes ?? 0;
				row.target_seconds = safe.target_seconds ?? DEFAULT_TARGET_SECONDS;
				row.current_weight = null;
			}
			if (ex.override) overrides[newEid] = { ...ex.override };
			if (ex.superset_with_next) supersetIds.push(newEid);
			insertEx.push(row);
			exIds.push(newEid);
		});
	}

	const importedExerciseIds = insertEx.map((row) => row.id as string);

	if (insertEx.length > 0) {
		const { error: exErr } = await supabase.from("exercises").insert(insertEx);
		if (exErr) throw new Error(formatDbError(exErr) || "Failed to import exercises");
	}

	let createdRoutineId: string | null = null;
	try {
		const { data: maxRow } = await supabase
			.from("routines")
			.select("display_order")
			.eq("user_id", uid)
			.order("display_order", { ascending: false })
			.limit(1)
			.maybeSingle();
		const nextOrder = (maxRow?.display_order ?? -1) + 1;
		const safeRoutineName =
			sanitizeTemplateName(parsed.name || "IMPORTED ROUTINE") || "IMPORTED ROUTINE";

		const { data: newRoutine, error: newRoutineErr } = await supabase
			.from("routines")
			.insert({
				user_id: uid,
				name: safeRoutineName,
				display_order: nextOrder,
				schedule_mode: parsed.scheduleMode,
				...(parsed.scheduleMode === "cycle"
					? {
							cycle_length: parsed.cycleLength,
							cycle_anchor_date: parsed.cycleAnchorDate ?? new Date().toISOString().slice(0, 10),
						}
					: {}),
			})
			.select("id, user_id, name, created_at, display_order")
			.single();
		if (newRoutineErr) {
			throw new Error(formatDbError(newRoutineErr) || "Failed to create imported routine");
		}
		createdRoutineId = newRoutine.id;

		// Insert templates with the new routine_id
		if (insertTpls.length > 0) {
			for (const tpl of insertTpls) tpl.routine_id = newRoutine.id;
			const { error: tplErr } = await supabase.from("templates").insert(insertTpls);
			if (tplErr) throw new Error(formatDbError(tplErr) || "Failed to import templates");
		}

		const resolveTpl = (name: string | null, key?: string | null): string | null => {
			if (key && keyToId.has(key)) return keyToId.get(key) ?? null;
			if (!name || !name.trim()) return null;
			const n = name.trim();
			return (
				nameToId.get(n) ??
				nameToId.get(n.toUpperCase()) ??
				nameToId.get(sanitizeTemplateName(n)) ??
				null
			);
		};

		if (parsed.scheduleMode === "cycle") {
			const cycleSlots = parsed.cycleSlots.map((slot) => {
				if (!slot) return null;
				return resolveTpl(slot, slot);
			});
			const { error: cycleErr } = await supabase.rpc("save_routine_cycle", {
				p_routine_id: newRoutine.id,
				p_length: parsed.cycleLength,
				p_anchor_date: parsed.cycleAnchorDate,
				p_slots: cycleSlots,
			});
			if (cycleErr) {
				throw new Error(formatDbError(cycleErr) || "Failed to import routine cycle");
			}
		} else {
			const allDays: Array<{
				routine_id: string;
				day_of_week: number;
				template_id: string | null;
			}> = [];
			for (let dow = 0; dow < 7; dow++) {
				const src = parsed.schedule.find((s) => s.day_of_week === dow);
				allDays.push({
					routine_id: newRoutine.id,
					day_of_week: dow,
					template_id: resolveTpl(
						src?.template_name ?? null,
						src?.template_key ?? null,
					),
				});
			}
			const { error: schedErr } = await supabase.from("routine_schedules").insert(allDays);
			if (schedErr) {
				throw new Error(formatDbError(schedErr) || "Failed to import week schedule");
			}
		}

		const templateCount = insertTpls.length;
		return {
			...newRoutine,
			template_count: templateCount,
			user_id: uid,
		} as Routine;
	} catch (e) {
		// Best-effort rollback: the import spans several statements, so remove anything
		// this call created before surfacing the error to the user.
		if (createdRoutineId) {
			await supabase
				.from("routines")
				.delete()
				.eq("id", createdRoutineId)
				.eq("user_id", uid);
		}
		if (importedExerciseIds.length > 0) {
			await supabase
				.from("exercises")
				.delete()
				.eq("user_id", uid)
				.in("id", importedExerciseIds);
		}
		throw e;
	}
}

/** Soft-fill invalid exercise rows from CSV so import doesn't hard-fail. */
function coerceImportedExercise(ex: {
	name: string;
	exercise_type: "reps" | "time";
	target_sets: number;
	target_reps: number | null;
	target_minutes: number | null;
	target_seconds: number | null;
	rest_minutes: number;
	rest_seconds: number;
	increment: number;
	current_weight: number | null;
}): DraftExerciseLike {
	const isTime = ex.exercise_type === "time";
	let sets = Number(ex.target_sets) || 0;
	if (sets < 1) sets = 1;
	if (isTime) {
		let mins = Number(ex.target_minutes) || 0;
		let secs = Number(ex.target_seconds) || 0;
		if (mins === 0 && secs === 0) secs = DEFAULT_TARGET_SECONDS;
		return {
			name: ex.name || "EXERCISE",
			exercise_type: "time",
			target_sets: sets,
			target_reps: 0,
			target_minutes: mins,
			target_seconds: secs,
			rest_minutes: Number(ex.rest_minutes) || 0,
			rest_seconds: Number(ex.rest_seconds) || 0,
			increment: Number(ex.increment) || 0,
			current_weight: null,
		};
	}
	let reps = Number(ex.target_reps) || 0;
	if (reps < 1) reps = DEFAULT_TARGET_REPS;
	return {
		name: ex.name || "EXERCISE",
		exercise_type: "reps",
		target_sets: sets,
		target_reps: reps,
		target_minutes: 0,
		target_seconds: 0,
		rest_minutes: Number(ex.rest_minutes) || 0,
		rest_seconds: Number(ex.rest_seconds) || 0,
		increment: Number(ex.increment) || 0,
		current_weight: ex.current_weight,
	};
}

// --- Routine file parse helpers (JSON v2 + legacy CSV) ---

type ParsedRoutineExport = {
	name: string;
	scheduleMode: "weekly" | "cycle";
	cycleLength: number;
	cycleAnchorDate: string | null;
	cycleSlots: Array<string | null>;
	schedule: Array<{
		day_of_week: number;
		template_name: string | null;
		template_key?: string | null;
	}>;
	templates: Array<{
		key?: string | null;
		name: string;
		color: number;
		icon: number;
		exercises: Array<{
			name: string;
			exercise_type: "reps" | "time";
			target_sets: number;
			target_reps: number | null;
			target_minutes: number | null;
			target_seconds: number | null;
			rest_minutes: number;
			rest_seconds: number;
			increment: number;
			current_weight: number | null;
			catalog_exercise_id?: number | null;
			catalog_muscle_ids?: number[];
			notes?: string | null;
			override?: ExerciseOverride;
			superset_with_next?: boolean;
		}>;
	}>;
};

function parseRoutineExportJson(jsonText: string): ParsedRoutineExport {
	let raw: unknown;
	try {
		raw = JSON.parse(jsonText);
	} catch {
		throw new Error("Invalid JSON — could not parse routine file.");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Invalid routine file — expected a JSON object.");
	}
	const doc = raw as Record<string, unknown>;
	const format = String(doc.format ?? "");
	if (format && format !== LIFT_ROUTINE_FORMAT) {
		throw new Error(`Unknown routine format “${format}”.`);
	}
	const schemaVersion = Number(doc.schemaVersion ?? 0);
	if (schemaVersion && schemaVersion > LIFT_ROUTINE_SCHEMA_VERSION) {
		throw new Error(
			`This routine file (schema v${schemaVersion}) is newer than this app. Update Lift Tracker.`,
		);
	}

	const meta = (doc.meta && typeof doc.meta === "object" ? doc.meta : {}) as Record<
		string,
		unknown
	>;
	let name = String(meta.name ?? doc.name ?? "").trim();
	if (!name) name = "IMPORTED ROUTINE";
	name = sanitizeTemplateName(name) || "IMPORTED ROUTINE";

	const scheduleMeta =
		doc.schedule && typeof doc.schedule === "object" && !Array.isArray(doc.schedule)
			? (doc.schedule as Record<string, unknown>)
			: {};
	const scheduleMode = String(scheduleMeta.mode ?? "weekly").toLowerCase() === "cycle"
		? "cycle"
		: "weekly";
	const cycleSlotsRaw = Array.isArray(scheduleMeta.slots) ? scheduleMeta.slots : [];
	const cycleLength = Math.max(
		1,
		Math.min(
			28,
			Math.floor(Number(scheduleMeta.cycleLength ?? scheduleMeta.cycle_length) || 0) ||
				cycleSlotsRaw.length ||
				7,
		),
	);
	const cycleSlots = Array.from({ length: cycleLength }, (_, i) => {
		const value = cycleSlotsRaw[i];
		return typeof value === "string" && value.trim() ? value.trim() : null;
	});
	const anchorRaw = scheduleMeta.anchorDate ?? scheduleMeta.anchor_date;
	const cycleAnchorDate =
		typeof anchorRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(anchorRaw)
			? anchorRaw
			: null;

	const weekRaw =
		doc.week && typeof doc.week === "object" && !Array.isArray(doc.week)
			? (doc.week as Record<string, unknown>)
			: {};
	const weekKeysRaw =
		doc.weekKeys && typeof doc.weekKeys === "object" && !Array.isArray(doc.weekKeys)
			? (doc.weekKeys as Record<string, unknown>)
			: {};
	const schedule: ParsedRoutineExport["schedule"] = [];
	for (let d = 0; d < 7; d++) {
		const key = ROUTINE_WEEK_KEYS[d];
		const altKeys = [key, key.toUpperCase(), String(d), `day_${d}`];
		let tname: string | null = null;
		for (const k of altKeys) {
			if (k in weekRaw) {
				const v = weekRaw[k];
				if (v == null || v === "") tname = null;
				else tname = String(v).trim() || null;
				break;
			}
		}
		let tkey: string | null = null;
		for (const k of altKeys) {
			if (k in weekKeysRaw) {
				const v = weekKeysRaw[k];
				if (v == null || v === "") tkey = null;
				else tkey = String(v).trim() || null;
				break;
			}
		}
		schedule.push({ day_of_week: d, template_name: tname, template_key: tkey });
	}

	const templatesIn = Array.isArray(doc.templates) ? doc.templates : [];
	const templates: ParsedRoutineExport["templates"] = [];

	for (const t of templatesIn) {
		if (!t || typeof t !== "object") continue;
		const tr = t as Record<string, unknown>;
		const tnameRaw = String(tr.name ?? "").trim();
		if (!tnameRaw) continue;
		const tname = sanitizeTemplateName(tnameRaw) || tnameRaw;
		const tkey = typeof tr.key === "string" && tr.key.trim() ? tr.key.trim() : null;

		let color = 0;
		const colorRaw = tr.color;
		if (typeof colorRaw === "number") {
			color = clampTemplateColor(colorRaw);
		} else if (colorRaw && typeof colorRaw === "object") {
			const c = colorRaw as Record<string, unknown>;
			if (typeof c.index === "number") color = clampTemplateColor(c.index);
			else if (typeof c.hex === "string") {
				const idx = hexToNearestIndex(String(c.hex));
				if (idx != null) color = idx;
			}
		} else if (typeof colorRaw === "string") {
			const asNum = parseInt(colorRaw, 10);
			if (Number.isFinite(asNum)) color = clampTemplateColor(asNum);
			else {
				const idx = hexToNearestIndex(colorRaw);
				if (idx != null) color = idx;
			}
		}

		const exercisesIn = Array.isArray(tr.exercises) ? tr.exercises : [];
		const exercises: ParsedRoutineExport["templates"][0]["exercises"] = [];
		for (const ex of exercisesIn) {
			if (!ex || typeof ex !== "object") continue;
			const er = ex as Record<string, unknown>;
			const parsedEx = jsonExerciseToParsed(er);
			if (parsedEx) exercises.push(parsedEx);
		}

		const icon = clampItemIcon(
			typeof tr.icon === "number" ? tr.icon : Number(tr.icon) || DEFAULT_TEMPLATE_ICON,
		);
		templates.push({ key: tkey, name: tname, color, icon, exercises });
	}

	// Templates only named in the week plan
	for (const s of schedule) {
		const tn = s.template_name;
		if (!tn) continue;
		const key = sanitizeTemplateName(tn) || tn;
		if (
			!templates.some(
				(t) =>
					t.name.toUpperCase() === key.toUpperCase() ||
					t.name.toUpperCase() === tn.toUpperCase(),
			)
		) {
			templates.push({ name: key, color: 0, icon: DEFAULT_TEMPLATE_ICON, exercises: [] });
		}
	}

	// Cycle slots may reference templates by key or by name
	for (const slot of cycleSlots) {
		if (!slot) continue;
		if (templates.some((t) => t.key === slot)) continue;
		const key = sanitizeTemplateName(slot) || slot;
		if (!templates.some((t) => t.name.toUpperCase() === key.toUpperCase())) {
			templates.push({ name: key, color: 0, icon: DEFAULT_TEMPLATE_ICON, exercises: [] });
		}
	}

	if (
		templates.length === 0 &&
		!schedule.some((s) => s.template_name) &&
		!cycleSlots.some(Boolean)
	) {
		throw new Error("Could not parse routine JSON — missing templates.");
	}

	return {
		name,
		scheduleMode,
		cycleLength,
		cycleAnchorDate,
		cycleSlots,
		schedule,
		templates,
	};
}

function jsonExerciseToParsed(
	er: Record<string, unknown>,
): ParsedRoutineExport["templates"][0]["exercises"][0] | null {
	const name = String(er.name ?? "").trim();
	if (!name) return null;
	const typeRaw = String(er.type ?? er.exercise_type ?? "reps").toLowerCase();
	const isTime = typeRaw === "time" || typeRaw === "timed";
	const sets = Math.max(0, Math.floor(Number(er.sets ?? er.target_sets) || 0));

	const catalogRaw = Number(er.catalogId ?? er.catalog_exercise_id);
	const catalogId =
		Number.isFinite(catalogRaw) && catalogRaw > 0 ? Math.round(catalogRaw) : null;
	const muscleRaw = er.muscleIds ?? er.catalog_muscle_ids;
	const muscleIds = Array.isArray(muscleRaw)
		? [
				...new Set(
					muscleRaw
						.map((value) => Number(value))
						.filter((value) => Number.isFinite(value) && value > 0)
						.map((value) => Math.round(value)),
				),
			]
		: [];
	const notes = typeof er.notes === "string" && er.notes.trim() ? er.notes : null;
	const override = jsonOverrideToParsed(er.override, isTime);
	const supersetWithNext = er.supersetWithNext === true || er.superset_with_next === true;

	const restSecTotal = Number(er.restSec ?? er.rest_sec);
	let restMin = Math.max(0, Math.floor(Number(er.rest_minutes ?? er.restMin) || 0));
	let restSec = Math.max(0, Math.floor(Number(er.rest_seconds ?? er.restSeconds) || 0));
	if (Number.isFinite(restSecTotal) && restSecTotal >= 0 && er.restSec != null) {
		restMin = Math.floor(restSecTotal / 60);
		restSec = Math.floor(restSecTotal % 60);
	} else if (er.rest && typeof er.rest === "object") {
		const r = er.rest as Record<string, unknown>;
		restMin = Math.max(0, Math.floor(Number(r.min ?? r.minutes) || 0));
		restSec = Math.max(0, Math.floor(Number(r.sec ?? r.seconds) || 0));
	}

	if (isTime) {
		let durationSec = Number(er.durationSec ?? er.duration_sec);
		let mins = Math.max(0, Math.floor(Number(er.target_minutes ?? er.durationMin) || 0));
		let secs = Math.max(0, Math.floor(Number(er.target_seconds ?? er.durationSeconds) || 0));
		if (Number.isFinite(durationSec) && durationSec >= 0 && er.durationSec != null) {
			mins = Math.floor(durationSec / 60);
			secs = Math.floor(durationSec % 60);
		}
		const progress = Number(er.progressSec ?? er.progress_sec ?? er.increment) || 0;
		return {
			name: sanitizeExerciseName(name) || name,
			exercise_type: "time",
			target_sets: sets,
			target_reps: null,
			target_minutes: mins,
			target_seconds: secs,
			rest_minutes: restMin,
			rest_seconds: restSec,
			increment: progress,
			current_weight: null,
			catalog_exercise_id: catalogId,
			catalog_muscle_ids: muscleIds,
			notes,
			override,
			superset_with_next: supersetWithNext,
		};
	}

	const reps = Math.max(0, Math.floor(Number(er.reps ?? er.target_reps) || 0));
	const loadRaw = er.loadKg ?? er.load_kg ?? er.current_weight ?? er.weight;
	const load =
		loadRaw == null || loadRaw === "" ? null : Number(loadRaw);
	const progress = Number(er.progressKg ?? er.progress_kg ?? er.increment) || 0;
	return {
		name: sanitizeExerciseName(name) || name,
		exercise_type: "reps",
		target_sets: sets,
		target_reps: reps,
		target_minutes: null,
		target_seconds: null,
		rest_minutes: restMin,
		rest_seconds: restSec,
		increment: progress,
		current_weight: load != null && !Number.isNaN(load) ? load : null,
		catalog_exercise_id: catalogId,
		catalog_muscle_ids: muscleIds,
		notes,
		override,
		superset_with_next: supersetWithNext,
	};
}

/** Parse an exported per-day override (same field names as template exercises). */
function jsonOverrideToParsed(raw: unknown, isTime: boolean): ExerciseOverride | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: ExerciseOverride = {};
	const sets = Number(r.sets ?? r.target_sets);
	if (Number.isFinite(sets) && sets >= 0) out.target_sets = Math.floor(sets);

	if (isTime) {
		const durationSec = Number(r.durationSec ?? r.duration_sec);
		let mins = Number(r.target_minutes);
		let secs = Number(r.target_seconds);
		if (Number.isFinite(durationSec) && durationSec >= 0 && r.durationSec != null) {
			mins = Math.floor(durationSec / 60);
			secs = Math.floor(durationSec % 60);
		}
		if (Number.isFinite(mins) && mins >= 0) out.target_minutes = Math.floor(mins);
		if (Number.isFinite(secs) && secs >= 0) out.target_seconds = Math.floor(secs);
	} else {
		const reps = Number(r.reps ?? r.target_reps);
		if (Number.isFinite(reps) && reps >= 0) out.target_reps = Math.floor(reps);
	}

	if ("loadKg" in r || "load_kg" in r || "current_weight" in r) {
		const loadRaw = r.loadKg ?? r.load_kg ?? r.current_weight;
		if (loadRaw === null || loadRaw === "") out.current_weight = null;
		else {
			const load = Number(loadRaw);
			if (Number.isFinite(load)) out.current_weight = load;
		}
	}

	const progress = Number(r.progressSec ?? r.progressKg ?? r.progress_sec ?? r.progress_kg);
	if (Number.isFinite(progress)) out.increment = Math.max(0, progress);

	const restSec = Number(r.restSec ?? r.rest_sec);
	if (Number.isFinite(restSec) && restSec >= 0 && (r.restSec != null || r.rest_sec != null)) {
		out.rest_minutes = Math.floor(restSec / 60);
		out.rest_seconds = Math.floor(restSec % 60);
	} else {
		const restMin = Number(r.rest_minutes ?? r.restMin);
		const restSeconds = Number(r.rest_seconds ?? r.restSeconds);
		if (Number.isFinite(restMin) && restMin >= 0) out.rest_minutes = Math.floor(restMin);
		if (Number.isFinite(restSeconds) && restSeconds >= 0) {
			out.rest_seconds = Math.floor(restSeconds);
		}
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out;
}

/** Unquote a single CSV field (handles "" escapes). */
function unquoteCsvField(raw: string): string {
	const t = raw.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
		return t.slice(1, -1).replace(/""/g, '"');
	}
	return t;
}

function parseRoutineExportCsv(csvText: string): ParsedRoutineExport {
	const text = String(csvText ?? "").replace(/^\uFEFF/, "");
	if (!text.trim()) {
		throw new Error("CSV file is empty.");
	}
	const lines = text.split(/\r?\n/);
	const meta = new Map<string, string>();
	const dataLines: string[] = [];

	for (const raw of lines) {
		const line = raw.trimEnd();
		if (!line.trim()) {
			if (dataLines.length > 0) dataLines.push("");
			continue;
		}
		if (line.startsWith("#")) {
			const body = line.replace(/^#\s*/, "");
			const comma = body.indexOf(",");
			if (comma >= 0) {
				const key = body.slice(0, comma).trim().toLowerCase();
				// Use CSV field parser so quoted values with commas work
				const rest = body.slice(comma + 1);
				const cells = parseCsvLine(rest);
				meta.set(key, unquoteCsvField(cells[0] ?? rest));
			} else {
				meta.set(body.trim().toLowerCase(), "");
			}
			continue;
		}
		dataLines.push(line);
	}

	if (!meta.has("lift-tracker-routine") && !meta.has("name")) {
		// Still try: maybe pure data CSV without meta (legacy export)
	} else if (meta.get("lift-tracker-routine") && meta.get("lift-tracker-routine") !== "1") {
		// future versions: still attempt best-effort
	}

	const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
	const shortToDow = new Map(dayNames.map((n, i) => [n, i]));
	shortToDow.set("sunday", 0);
	shortToDow.set("monday", 1);
	shortToDow.set("tuesday", 2);
	shortToDow.set("wednesday", 3);
	shortToDow.set("thursday", 4);
	shortToDow.set("friday", 5);
	shortToDow.set("saturday", 6);

	const schedule: Array<{ day_of_week: number; template_name: string | null }> = [];
	for (let d = 0; d < 7; d++) {
		const key = `day_${d}_${dayNames[d]}`;
		const alt = `day_${d}`;
		const raw = meta.get(key) ?? meta.get(alt) ?? "";
		const name = unquoteCsvField(raw).trim();
		schedule.push({ day_of_week: d, template_name: name || null });
	}

	// Find header row
	let headerIdx = dataLines.findIndex((l) => {
		const cols = parseCsvLine(l).map((c) => c.trim().toLowerCase());
		return cols[0] === "template" && cols.some((c) => c.includes("exercise"));
	});
	if (headerIdx < 0) {
		headerIdx = dataLines.findIndex((l) => parseCsvLine(l)[0]?.trim().toLowerCase() === "template");
	}

	const templatesMap = new Map<
		string,
		{
			name: string;
			color: number;
			icon: number;
			exercises: ParsedRoutineExport["templates"][0]["exercises"];
			assignedDays: number[];
		}
	>();

	if (headerIdx >= 0) {
		const headers = parseCsvLine(dataLines[headerIdx]).map((h) => h.trim().toLowerCase());
		const idx = (names: string[]) => {
			for (const n of names) {
				const i = headers.indexOf(n);
				if (i >= 0) return i;
			}
			return -1;
		};
		const iTemplate = idx(["template"]);
		const iColor = idx(["color"]);
		const iDays = idx(["assigned days", "days"]);
		const iExNum = idx(["exercise #", "exercise#", "#"]);
		const iExercise = idx(["exercise"]);
		const iType = idx(["type"]);
		const iSets = idx(["sets"]);
		const iReps = idx(["reps"]);
		const iDurMin = idx(["duration min", "minutes"]);
		const iDurSec = idx(["duration sec", "seconds"]);
		const iRestMin = idx(["rest min", "rest minutes"]);
		const iRestSec = idx(["rest sec", "rest seconds", "rest (mm:ss)"]);
		const iLoad = idx(["load (kg)", "load", "weight"]);
		const iProg = idx(["progress (+kg)", "progress", "increment"]);

		const cell = (cols: string[], i: number) => (i >= 0 && i < cols.length ? cols[i].trim() : "");

		for (let li = headerIdx + 1; li < dataLines.length; li++) {
			const line = dataLines[li];
			if (!line.trim()) continue;
			const cols = parseCsvLine(line);
			const tname = cell(cols, iTemplate);
			if (!tname) continue;

			let pack = templatesMap.get(tname);
			if (!pack) {
				const colorRaw = cell(cols, iColor);
				pack = {
					name: sanitizeTemplateName(tname) || tname,
					color: Math.max(0, Math.min(255, parseInt(colorRaw || "0", 10) || 0)),
					icon: DEFAULT_TEMPLATE_ICON,
					exercises: [],
					assignedDays: [],
				};
				templatesMap.set(tname, pack);
			}

			// Parse assigned days if meta schedule empty
			const daysStr = cell(cols, iDays);
			if (daysStr && daysStr !== "—" && daysStr !== "-") {
				for (const part of daysStr.split(/[,;|]/)) {
					const p = part.trim().toLowerCase().slice(0, 3);
					const full = part.trim().toLowerCase();
					const dow = shortToDow.get(full) ?? shortToDow.get(p);
					if (dow != null && !pack.assignedDays.includes(dow)) pack.assignedDays.push(dow);
				}
			}

			const exName = cell(cols, iExercise);
			if (!exName) continue;

			const typeRaw = cell(cols, iType).toLowerCase();
			const isTime = typeRaw === "time" || typeRaw === "timed";
			const sets = parseInt(cell(cols, iSets) || "0", 10) || 0;
			const reps = parseInt(cell(cols, iReps) || "0", 10) || 0;
			let durMin = parseInt(cell(cols, iDurMin) || "0", 10) || 0;
			let durSec = parseInt(cell(cols, iDurSec) || "0", 10) || 0;
			// Support legacy "Duration" as m:ss in one column if separate empty
			let restMin = 0;
			let restSec = 0;
			if (iRestSec >= 0 && headers[iRestSec]?.includes("mm:ss")) {
				// Legacy single "Rest (mm:ss)" column
				const m = cell(cols, iRestSec).match(/^(\d+):(\d+)$/);
				if (m) {
					restMin = parseInt(m[1], 10) || 0;
					restSec = parseInt(m[2], 10) || 0;
				}
			} else {
				restMin = parseInt(cell(cols, iRestMin) || "0", 10) || 0;
				restSec = parseInt(cell(cols, iRestSec) || "0", 10) || 0;
			}
			// Legacy "Duration" as m:ss when split columns absent
			if (isTime && !durMin && !durSec) {
				const iDur = idx(["duration"]);
				const durCell = cell(cols, iDur);
				const dm = durCell.match(/^(\d+):(\d+)$/);
				if (dm) {
					durMin = parseInt(dm[1], 10) || 0;
					durSec = parseInt(dm[2], 10) || 0;
				}
			}
			const loadRaw = cell(cols, iLoad);
			const load = loadRaw === "" ? null : Number(loadRaw);
			const prog = Number(cell(cols, iProg) || "0") || 0;

			pack.exercises.push({
				name: sanitizeExerciseName(exName) || exName,
				exercise_type: isTime ? "time" : "reps",
				target_sets: sets,
				target_reps: isTime ? null : reps,
				target_minutes: isTime ? durMin : null,
				target_seconds: isTime ? durSec : null,
				rest_minutes: restMin,
				rest_seconds: restSec,
				increment: prog,
				current_weight: load != null && !Number.isNaN(load) ? load : null,
			});
			void iExNum;
		}
	}

	// If schedule meta all empty, reconstruct from Assigned Days
	const metaHasSchedule = schedule.some((s) => s.template_name);
	if (!metaHasSchedule) {
		for (const pack of templatesMap.values()) {
			for (const d of pack.assignedDays) {
				schedule[d] = { day_of_week: d, template_name: pack.name };
			}
		}
	}

	let name = unquoteCsvField(meta.get("name") ?? "").trim();
	if (!name) name = "IMPORTED ROUTINE";
	name = sanitizeTemplateName(name) || "IMPORTED ROUTINE";

	// Templates referenced only in the week plan (no exercise rows) still need rows
	if (metaHasSchedule) {
		for (const s of schedule) {
			const tn = s.template_name;
			if (!tn) continue;
			if (!templatesMap.has(tn) && !templatesMap.has(sanitizeTemplateName(tn))) {
				const safe = sanitizeTemplateName(tn) || tn;
				templatesMap.set(tn, {
					name: safe,
					color: 0,
					icon: 0,
					exercises: [],
					assignedDays: [],
				});
			}
		}
	}

	if (templatesMap.size === 0 && !metaHasSchedule) {
		throw new Error("Could not parse routine CSV — missing templates or metadata.");
	}

	return {
		name,
		scheduleMode: "weekly",
		cycleLength: 7,
		cycleAnchorDate: null,
		cycleSlots: [],
		schedule,
		templates: [...templatesMap.values()].map(({ name: n, color, icon, exercises }) => ({
			name: n,
			color,
			icon: clampItemIcon(icon ?? DEFAULT_TEMPLATE_ICON),
			exercises,
		})),
	};
}
