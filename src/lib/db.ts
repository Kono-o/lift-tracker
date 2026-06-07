import { createClient, type User } from "@supabase/supabase-js";
import {
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";
import {
	sanitizeBaseKg,
	sanitizeExerciseName,
	sanitizeTemplateName,
	sanitizeExerciseRowForDb,
	validateDraftExercise,
	validateDraftExercises,
	type DraftExerciseLike,
} from "./exerciseSanitize";
import { createDbTrackingFetch, pulseDbActivity } from "./dbActivity";

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
		lower.includes("templates_user_id_fkey") ||
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
		return "Could not save workout — invalid duration. Try finishing again after a few seconds.";
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

	return raw ?? "Could not delete account. Please try again.";
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

	increment: number;
	current_weight: number | null;
	/** Present when an exercise is loaded in template context. */
	display_order?: number;
}

const PERSISTED_EXERCISE_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPersistedExerciseId(id: string | null | undefined): boolean {
	return !!id && PERSISTED_EXERCISE_ID_RE.test(id) && !id.startsWith("temp-");
}

function exerciseFromLink(
	link: { display_order: number; exercises: Exercise | Exercise[] | null },
): Exercise | null {
	const raw = link.exercises;
	const exercise = Array.isArray(raw) ? raw[0] : raw;
	if (!exercise) return null;
	return { ...exercise, display_order: link.display_order };
}

function mapTemplateExercises(templateRow: {
	template_exercises?: Array<{
		display_order: number;
		exercises: Exercise | Exercise[] | null;
	}>;
}): Exercise[] {
	return (templateRow.template_exercises ?? [])
		.map(exerciseFromLink)
		.filter((exercise): exercise is Exercise => exercise !== null)
		.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
}

async function fetchExercisesForTemplate(templateId: string): Promise<Exercise[]> {
	// Load the ordered links first (more reliable than embedded relation in all setups)
	const { data: linkRows, error: linkErr } = await supabase
		.from("template_exercises")
		.select("exercise_id, display_order")
		.eq("template_id", templateId)
		.order("display_order");
	if (linkErr) throw linkErr;

	const orderedIds = (linkRows ?? []).map((r: any) => r.exercise_id as string);
	if (orderedIds.length === 0) return [];

	// Then fetch the exercise rows by id (avoids problematic deep embeds)
	const { data: exRows, error: exErr } = await supabase
		.from("exercises")
		.select("*")
		.in("id", orderedIds);
	if (exErr) throw exErr;

	const exById = new Map((exRows ?? []).map((e: any) => [e.id as string, e as Exercise]));

	const result = (linkRows ?? [])
		.map((link: any) => {
			const ex = exById.get(link.exercise_id);
			if (!ex) return null;
			return { ...ex, display_order: link.display_order } as Exercise;
		})
		.filter((e): e is Exercise => !!e);
	return result;
}

export interface Template {
	id: string;
	user_id: string;
	name: string;
	color?: number; // 0-4 (5 colors), defaults to 0
	display_order?: number;
	exercises: Exercise[];
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

export interface WorkoutHistory {
	id: string;
	user_id: string;

	workout_date: string;

	template_id: string | null;
	template_name_snapshot: string | null;

	is_skipped: boolean;

	// Top-level scalar fields (mirrors values in performance_snapshot for fast queries)
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
	times?: Record<string, { result: string }>;
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
function todayDateString(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Completed (non-skipped) rows: DB rejects duration_seconds = 0. */
function normalizeCompletedWorkoutDuration(seconds: number): number {
	if (!Number.isFinite(seconds)) return 1;
	return Math.max(1, Math.round(seconds));
}

/** Parse `01m30s` or raw seconds from timer UI. */
export function parseTimeResultToSeconds(result: string): number | null {
	const m = result.match(/(\d+)m(\d+)s/i);
	if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
	const n = parseFloat(result);
	return Number.isFinite(n) ? Math.round(n) : null;
}

export function isWorkoutInProgress(
	log: Pick<WorkoutHistory, "is_skipped" | "workout_snapshot"> | null,
): boolean {
	return (
		!!log &&
		!log.is_skipped &&
		!log.workout_snapshot?.is_rest &&
		!!log.workout_snapshot?.in_progress
	);
}

function buildExerciseSnapshotsFromPerformance(
	template: Template,
	performanceSnapshot: PerformanceSnapshot,
): WorkoutSnapshotExercise[] {
	return template.exercises.map((ex) => {
		if (ex.exercise_type === "reps") {
			const sets: WorkoutSnapshotExerciseSet[] = Array.from(
				{ length: ex.target_sets },
				(_, s) => {
					const raw = performanceSnapshot.reps?.[`${ex.id}-${s}`];
					const repsCompleted =
						raw != null && raw > 0 ? raw : null;
					return {
						set_number: s + 1,
						reps_completed: repsCompleted,
						seconds_completed: null,
						weight: ex.current_weight ?? null,
						is_pr: false,
					};
				},
			);
			return {
				exercise_id: ex.id,
				name: ex.name,
				exercise_type: "reps",
				exercise_is_pr: false,
				target_sets: ex.target_sets,
				target_reps: ex.target_reps,
				increment: ex.increment,
				weight_before: ex.current_weight,
				weight_after: ex.current_weight,
				sets,
			};
		}

		const sets: WorkoutSnapshotExerciseSet[] = Array.from(
			{ length: ex.target_sets },
			(_, s) => {
				const entry = performanceSnapshot.times?.[`${ex.id}-${s}`];
				return {
					set_number: s + 1,
					reps_completed: null,
					seconds_completed: entry
						? parseTimeResultToSeconds(entry.result)
						: null,
					weight: null,
					is_pr: false,
				};
			},
		);

		return {
			exercise_id: ex.id,
			name: ex.name,
			exercise_type: "time",
			exercise_is_pr: false,
			target_sets: ex.target_sets,
			target_minutes: ex.target_minutes,
			target_seconds: ex.target_seconds,
			sets,
		};
	});
}

async function replaceTodayWorkoutRow(row: Record<string, unknown>) {
	const uid = await requireUserId();
	const date = todayDateString();
	const { error: deleteError } = await supabase
		.from("workout_history")
		.delete()
		.eq("user_id", uid)
		.eq("workout_date", date);
	if (deleteError) throw deleteError;

	const { error: insertError } = await supabase
		.from("workout_history")
		.insert({ user_id: uid, workout_date: date, ...row });
	if (insertError) throw insertError;
}

/**
 * Fetch the all-time best weight for a given exercise across all history.
 * Used to determine if a set is a new personal record.
 */
async function getExerciseAllTimeBest(exerciseId: string): Promise<number> {
	const { data, error } = await supabase
		.from("workout_history")
		.select("workout_snapshot")
		.not("workout_snapshot", "is", null);

	if (error || !data) return 0;

	let best = 0;

	for (const row of data) {
		const snapshot = row.workout_snapshot as WorkoutSnapshot;
		if (snapshot.in_progress || snapshot.skipped || snapshot.is_rest) continue;
		const match = snapshot.exercises?.find((e) => e.exercise_id === exerciseId);
		if (!match) continue;
		for (const set of match.sets ?? []) {
			if (set.weight != null && set.weight > best) {
				best = set.weight;
			}
		}
	}

	return best;
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

	/** Removes all app rows for the signed-in user (RLS / user_id). */
	async deleteAllUserData() {
		const {
			data: { user },
			error: userErr,
		} = await supabase.auth.getUser();
		if (userErr) throw userErr;
		if (!user) throw new Error("Not signed in");

		const uid = user.id;
		const results = await Promise.all([
			supabase.from("exercises").delete().eq("user_id", uid),
			supabase.from("workout_history").delete().eq("user_id", uid),
			supabase.from("templates").delete().eq("user_id", uid),
			supabase.from("schedule").delete().eq("user_id", uid),
		]);

		for (const r of results) {
			if (r.error) throw r.error;
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
			const { error: signOutErr } = await supabase.auth.signOut();
			if (signOutErr) throw signOutErr;
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

		const { error: signOutErr } = await supabase.auth.signOut();
		if (signOutErr) throw signOutErr;
	},

	async getSession() {
		const { data, error } = await supabase.auth.getSession();
		if (error) throw error;
		return data.session;
	},

	/* ==================================================
		 APP LOAD
		 ================================================== */

	async getAppData() {
		const [scheduleRes, templatesRes, libraryRes, todayRes] = await Promise.all([
			supabase.from("schedule").select("*").order("day_of_week"),

			// Load templates without embedded join. We hydrate exercises below using
			// the junction (preferred) or legacy template_id on exercises (for accounts
			// that predate the shared_exercise_library migration).
			supabase.from("templates").select(`id, user_id, name, color, display_order`).order("display_order").order("created_at"),

			supabase.from("exercises").select("*").order("created_at"),

			supabase
				.from("workout_history")
				.select("*")
				.eq("workout_date", todayDateString())
				.maybeSingle(),
		]);

		if (scheduleRes.error) throw scheduleRes.error;
		if (templatesRes.error) throw templatesRes.error;
		if (libraryRes.error) throw libraryRes.error;
		if (todayRes.error) throw todayRes.error;

		const exerciseLibrary = (libraryRes.data ?? []) as Exercise[];

		// Load junction links safely. If the table/relation does not exist yet
		// (migration not run), we fall back to legacy attachment below.
		let links: Array<{ template_id: string; exercise_id: string; display_order: number }> = [];
		try {
			const linksRes = await supabase
				.from("template_exercises")
				.select("template_id, exercise_id, display_order")
				.order("display_order");
			if (!linksRes.error && linksRes.data) {
				links = linksRes.data as any;
			}
		} catch {
			// ignore — old DB without the junction table
		}

		// Build lookup for current exercises
		const exById = new Map(exerciseLibrary.map((e) => [e.id, e] as const));

		// Legacy index: for pre-migration data where exercises still carry template_id + display_order
		const legacyByTpl = new Map<string, Exercise[]>();
		for (const ex of exerciseLibrary as any[]) {
			const tid = ex?.template_id;
			if (typeof tid === "string" && tid) {
				const list = legacyByTpl.get(tid) || [];
				list.push({ ...ex, display_order: ex.display_order ?? 0 });
				legacyByTpl.set(tid, list);
			}
		}

		const templates: Template[] = (templatesRes.data ?? []).map((t: any) => {
			// Preferred path: use template_exercises links (post-migration model)
			let exs: Exercise[] = links
				.filter((l) => l.template_id === t.id)
				.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
				.map((l) => {
					const base = exById.get(l.exercise_id);
					if (!base) return null;
					return { ...base, display_order: l.display_order } as Exercise;
				})
				.filter((e): e is Exercise => !!e);

			// Legacy fallback for accounts that never ran the shared exercise library migration.
			// Exercises may still have a template_id column pointing at the template.
			if (exs.length === 0) {
				const leg = legacyByTpl.get(t.id) || [];
				exs = leg
					.slice()
					.sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))
					.map((e) => ({ ...e }));
			}

			return {
				id: t.id,
				user_id: t.user_id,
				name: t.name,
				color: typeof t.color === 'number' ? t.color : 0,
				display_order: typeof t.display_order === 'number' ? t.display_order : 0,
				exercises: exs,
			};
		});

		return {
			schedule: (scheduleRes.data ?? []) as ScheduleRow[],
			templates,
			exerciseLibrary,
			todayLog: (todayRes.data as WorkoutHistory) ?? null,
		};
	},

	/* ==================================================
		 BODYWEIGHT (separate daily tracking, not tied to workouts)
		 ================================================== */

	async getBodyweightLogs(days = 90): Promise<Record<string, number>> {
		const since = new Date();
		since.setDate(since.getDate() - days);
		const sinceStr = since.toISOString().slice(0, 10);

		const { data, error } = await supabase
			.from("bodyweight_logs")
			.select("log_date, weight")
			.gte("log_date", sinceStr)
			.order("log_date", { ascending: false });

		if (error) {
			// table may not exist yet on old DBs — fail soft
			console.warn("[db] bodyweight_logs fetch warning:", error.message);
			return {};
		}

		const map: Record<string, number> = {};
		for (const row of data ?? []) {
			if (row.log_date && typeof row.weight === "number") {
				map[row.log_date] = row.weight;
			}
		}
		return map;
	},

	async saveBodyweight(logDate: string, weight: number) {
		const { data: { user } } = await supabase.auth.getUser();
		if (!user) throw new Error("Not authenticated");

		const { error } = await supabase.from("bodyweight_logs").upsert(
			{
				user_id: user.id,
				log_date: logDate,
				weight,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: "user_id,log_date" }
		);

		if (error) throw error;
	},

	async deleteBodyweight(logDate: string) {
		const { error } = await supabase
			.from("bodyweight_logs")
			.delete()
			.eq("log_date", logDate);

		if (error) throw error;
	},

	/* ==================================================
		 SCHEDULE
		 RLS ensures we only touch the current user's rows.
		 Schedule uses composite PK (user_id, day_of_week),
		 so we filter on day_of_week only — user_id is
		 enforced server-side by RLS.
		 ================================================== */

	async assignTemplateToDay(dayOfWeek: number, templateId: string | null) {
		const uid = await requireUserId();

		if (templateId) {
			const { count, error: countErr } = await supabase
				.from("template_exercises")
				.select("*", { count: "exact", head: true })
				.eq("template_id", templateId)
				.eq("user_id", uid);
			if (countErr) throw countErr;
			if (!count) {
				throw new Error("Add exercises before assigning this template.");
			}
		}

		const { error } = await supabase.from("schedule").upsert(
			{
				user_id: uid,
				day_of_week: dayOfWeek,
				template_id: templateId,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: "user_id,day_of_week" },
		);

		if (error) throw error;
	},

	/* ==================================================
		 TEMPLATE CRUD
		 ================================================== */

	async createTemplate(name: string): Promise<Template | null> {
		const uid = await requireUserId();
		const safeName = sanitizeTemplateName(name.trim()) || "NEW TEMPLATE";

		// Append to the end of the user's template list
		const { count } = await supabase
			.from("templates")
			.select("id", { count: "exact", head: true })
			.eq("user_id", uid);
		const nextOrder = (count ?? 0);

		const { data, error } = await supabase
			.from("templates")
			.insert([{ name: safeName, user_id: uid, color: 0, display_order: nextOrder }])
			.select()
			.single();

		if (error) throw error;
		if (!data) return null;

		return { ...data, exercises: [] };
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
		const c = Math.max(0, Math.min(4, Math.floor(color || 0)));
		const { error } = await supabase
			.from("templates")
			.update({ color: c })
			.eq("id", templateId);
		if (error) throw error;
	},

	async updateTemplateDisplayOrders(orders: Array<{ id: string; display_order: number }>) {
		for (const { id, display_order } of orders) {
			const { error } = await supabase
				.from("templates")
				.update({ display_order })
				.eq("id", id);
			if (error) throw error;
		}
	},

	/**
	 * Sync template membership + exercise rows (shared library; no duplication).
	 *
	 * Multiple templates can reference the exact same exercise row (by exercise_id
	 * via template_exercises join). This is intentional for progressive overload:
	 * current_weight / increment live on the exercise. Finishing a workout on any
	 * template that uses the exercise will advance the shared baseline.
	 *
	 * Draft items with a real persisted UUID id → UPDATE the canonical exercise
	 * (definition + overload params), then ensure a link exists.
	 * Draft items with temp- ids → INSERT new exercise row, then link.
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
			increment?: number;
			current_weight?: number | null;
		}>,
	): Promise<Exercise[]> {
		const uid = await requireUserId();

		const validationError = validateDraftExercises(
			exercises as DraftExerciseLike[],
		);
		if (validationError) throw new Error(validationError);

		if (exercises.length === 0) {
			const { error: clearErr } = await supabase
				.from("template_exercises")
				.delete()
				.eq("template_id", templateId);
			if (clearErr) throw clearErr;
			return [];
		}

		const savedIds: string[] = [];

		for (let i = 0; i < exercises.length; i++) {
			const d = exercises[i];
			const safe = sanitizeExerciseRowForDb(d as DraftExerciseLike);
			const row = {
				user_id: uid,
				name: safe.name,
				exercise_type: safe.exercise_type,
				target_sets: safe.target_sets ?? 0,
				target_reps: safe.exercise_type === "reps" ? (safe.target_reps ?? 0) : 0,
				target_minutes:
					safe.exercise_type === "time" ? (safe.target_minutes ?? 0) : 0,
				target_seconds:
					safe.exercise_type === "time" ? (safe.target_seconds ?? 0) : 0,
				increment: safe.increment ?? 0,
				current_weight:
					safe.exercise_type === "reps" ? (safe.current_weight ?? null) : null,
			};

			let exerciseId = typeof d.id === "string" ? d.id : "";
			if (isPersistedExerciseId(exerciseId)) {
				const { error: updateErr } = await supabase
					.from("exercises")
					.update(row)
					.eq("id", exerciseId);
				if (updateErr) throw updateErr;
			} else {
				const { data, error: insertErr } = await supabase
					.from("exercises")
					.insert([row])
					.select()
					.single();
				if (insertErr) throw insertErr;
				exerciseId = data.id;
			}

			savedIds.push(exerciseId);

			const { error: linkErr } = await supabase.from("template_exercises").upsert(
				{
					template_id: templateId,
					exercise_id: exerciseId,
					user_id: uid,
					display_order: i,
				},
				{ onConflict: "template_id,exercise_id" },
			);
			if (linkErr) throw linkErr;
		}

		const { error: pruneErr } = await supabase
			.from("template_exercises")
			.delete()
			.eq("template_id", templateId)
			.not("exercise_id", "in", `(${savedIds.join(",")})`);
		if (pruneErr) throw pruneErr;

		return fetchExercisesForTemplate(templateId);
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
		await Promise.all(
			exercises.map((exercise, index) =>
				supabase
					.from("template_exercises")
					.update({ display_order: index })
					.eq("template_id", templateId)
					.eq("exercise_id", exercise.id),
			),
		);
	},

	/* ==================================================
		 HISTORY
		 ================================================== */

	async skipWorkout(templateId: string | null, templateName?: string | null) {
		const uid = await requireUserId();
		const date = todayDateString();
		const { error: deleteError } = await supabase
			.from("workout_history")
			.delete()
			.eq("user_id", uid)
			.eq("workout_date", date);
		if (deleteError) throw deleteError;

		const { error } = await supabase.from("workout_history").insert({
			user_id: uid,
			workout_date: date,
			template_id: templateId,
			template_name_snapshot: templateName,
			is_skipped: true,
			duration_seconds: null,
			is_perfect_day: false,
			performance_snapshot: {},
			workout_snapshot: {
				skipped: true,
				template_name: templateName ?? undefined,
			} satisfies WorkoutSnapshot,
		});

		if (error) throw error;
	},

	async submitWorkoutSession(
		template: Template,
		performanceSnapshot: PerformanceSnapshot,
		durationSeconds: number,
	) {
		const duration = normalizeCompletedWorkoutDuration(durationSeconds);

		// ── 1. Fetch all-time bests for PR detection ──
		const bests = await Promise.all(
			template.exercises.map((ex) =>
				ex.exercise_type === "reps"
					? getExerciseAllTimeBest(ex.id)
					: Promise.resolve(0),
			),
		);

		// ── 2. Build typed exercise snapshots ──
		let totalVolumeKg = 0;
		let totalSets = 0;
		let prCount = 0;

		const exerciseSnapshots: WorkoutSnapshotExercise[] = template.exercises.map(
			(ex, idx) => {
				if (ex.exercise_type === "reps") {
					const allTimeBest = bests[idx];
					const currentWeight = ex.current_weight ?? 0;

					const sets: WorkoutSnapshotExerciseSet[] = Array.from(
						{ length: ex.target_sets },
						(_, s) => {
							const raw = performanceSnapshot.reps?.[`${ex.id}-${s}`];
							const repsCompleted =
								raw != null && raw > 0 ? raw : null;
							const weight = currentWeight;
							const hitTarget =
								repsCompleted !== null && repsCompleted >= ex.target_reps;
							const isPr = hitTarget && weight > allTimeBest;

							if (repsCompleted !== null) {
								totalVolumeKg += repsCompleted * weight;
								totalSets += 1;
							}

							return {
								set_number: s + 1,
								reps_completed: repsCompleted,
								seconds_completed: null,
								weight,
								is_pr: isPr,
							};
						},
					);

					const success = sets.every(
						(s) =>
							s.reps_completed !== null && s.reps_completed >= ex.target_reps,
					);

					const exerciseIsPr = success && sets.some((s) => s.is_pr);
					if (exerciseIsPr) prCount += 1;

					return {
						exercise_id: ex.id,
						name: ex.name,
						exercise_type: "reps",
						exercise_is_pr: exerciseIsPr,
						target_sets: ex.target_sets,
						target_reps: ex.target_reps,
						increment: ex.increment,
						weight_before: ex.current_weight,
						weight_after: success
							? sanitizeBaseKg(
									Number(ex.current_weight ?? 0) + Number(ex.increment),
								)
							: ex.current_weight,
						sets,
					};
				}

				// exercise_type === "time"
				const sets: WorkoutSnapshotExerciseSet[] = Array.from(
					{ length: ex.target_sets },
					(_, s) => {
						const entry = performanceSnapshot.times?.[`${ex.id}-${s}`];
						totalSets += 1;
						return {
							set_number: s + 1,
							reps_completed: null,
							seconds_completed: entry
								? parseTimeResultToSeconds(entry.result)
								: null,
							weight: null,
							is_pr: false,
						};
					},
				);

				return {
					exercise_id: ex.id,
					name: ex.name,
					exercise_type: "time",
					exercise_is_pr: false,
					target_sets: ex.target_sets,
					target_minutes: ex.target_minutes,
					target_seconds: ex.target_seconds,
					sets,
				};
			},
		);

		const isPerfectDay =
			prCount > 0 &&
			prCount ===
			template.exercises.filter((ex) => ex.exercise_type === "reps").length;

		// ── 3. Assemble full snapshots ──
		const workoutSnapshot: WorkoutSnapshot = {
			template_name: template.name,
			duration_seconds: duration,
			is_perfect_day: isPerfectDay,
			exercises: exerciseSnapshots,
		};

		const enrichedPerformanceSnapshot: PerformanceSnapshot = {
			...performanceSnapshot,
			total_volume_kg: Math.round(totalVolumeKg),
			total_sets: totalSets,
			pr_count: prCount,
			is_perfect_day: isPerfectDay,
			duration_seconds: duration,
		};

		// ── 4. Replace today's log (one row per user per day) ──
		await replaceTodayWorkoutRow({
			template_id: template.id,
			template_name_snapshot: template.name,
			is_skipped: false,
			duration_seconds: duration,
			is_perfect_day: isPerfectDay,
			performance_snapshot: enrichedPerformanceSnapshot,
			workout_snapshot: workoutSnapshot,
		});

		// ── 5. Update current_weight on exercises ──
		const weightUpdates = template.exercises
			.filter((ex) => ex.exercise_type === "reps")
			.map((ex) => {
				const success = Array.from({ length: ex.target_sets }, (_, s) => {
					const actual = performanceSnapshot.reps?.[`${ex.id}-${s}`];
					return actual !== undefined && actual >= ex.target_reps;
				}).every(Boolean);

				const nextWeight = success
					? sanitizeBaseKg(
							Number(ex.current_weight ?? 0) + Number(ex.increment),
						)
					: ex.current_weight;

				return supabase
					.from("exercises")
					.update({ current_weight: nextWeight })
					.eq("id", ex.id);
			});

		await Promise.all(weightUpdates);
	},

	/** Autosave reps/times while a workout is in progress (one row per day). */
	async saveWorkoutProgress(
		template: Template,
		performanceSnapshot: PerformanceSnapshot,
		elapsedSeconds: number,
		startedAtMs: number,
	) {
		const elapsed = Math.max(0, Math.round(elapsedSeconds));
		const perfMaps: PerformanceSnapshot = {
			reps: performanceSnapshot.reps ?? {},
			times: performanceSnapshot.times ?? {},
			started_at: startedAtMs,
			duration_seconds: elapsed,
		};

		const workoutSnapshot: WorkoutSnapshot = {
			in_progress: true,
			template_name: template.name,
			duration_seconds: elapsed,
			exercises: buildExerciseSnapshotsFromPerformance(template, perfMaps),
		};

		await replaceTodayWorkoutRow({
			template_id: template.id,
			template_name_snapshot: template.name,
			is_skipped: false,
			duration_seconds: null,
			is_perfect_day: false,
			performance_snapshot: perfMaps,
			workout_snapshot: workoutSnapshot,
		});
	},

	async deleteWorkoutLog(dateStr?: string) {
		const uid = await requireUserId();
		const { error } = await supabase
			.from("workout_history")
			.delete()
			.eq("user_id", uid)
			.eq("workout_date", dateStr ?? todayDateString());

		if (error) throw error;
	},

	async logRestForDate(dateStr: string) {
		const uid = await requireUserId();
		const { error } = await supabase.from("workout_history").insert({
			user_id: uid,
			workout_date: dateStr,
			template_id: null,
			template_name_snapshot: null,
			is_skipped: false,
			duration_seconds: null,
			is_perfect_day: false,
			performance_snapshot: {},
			workout_snapshot: { is_rest: true } satisfies WorkoutSnapshot,
		});

		if (error) throw error;
	},

	async deleteLogForDate(dateStr: string) {
		const { error } = await supabase
			.from("workout_history")
			.delete()
			.eq("workout_date", dateStr);

		if (error) throw error;
	},

	async getLogForDate(dateStr: string): Promise<WorkoutHistory | null> {
		const { data, error } = await supabase
			.from("workout_history")
			.select("*")
			.eq("workout_date", dateStr)
			.maybeSingle();

		if (error) throw error;
		return (data as WorkoutHistory) ?? null;
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
			.gte("workout_date", since.toISOString().slice(0, 10))
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
};
