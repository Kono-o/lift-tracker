import { createClient } from "@supabase/supabase-js";
import {
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
} from "$env/static/public";

export const supabase = createClient(
	PUBLIC_SUPABASE_URL,
	PUBLIC_SUPABASE_ANON_KEY,
);

export interface Exercise {
	id: string;
	template_id: string;

	name: string;

	exercise_type: "reps" | "time";

	target_sets: number;
	target_reps: number;

	target_minutes: number;
	target_seconds: number;

	increment: number;

	current_weight: number | null;

	display_order: number;
}

export interface Template {
	id: string;
	name: string;
	exercises: Exercise[];
}

export interface WorkoutHistory {
	id: string;

	workout_date: string;

	template_id: string | null;

	template_name_snapshot: string | null;

	is_skipped: boolean;

	performance_snapshot: Record<string, any>;

	workout_snapshot: Record<string, any>;

	created_at: string;
}

function todayDateString() {
	return new Date().toISOString().slice(0, 10);
}

export const db = {
	/* ==================================================
		 APP LOAD
	  ================================================== */

	async getAppData() {
		const [scheduleRes, templatesRes, todayRes] = await Promise.all([
			supabase.from("schedule").select("*").order("day_of_week"),

			supabase.from("templates").select(`
				id,
				name,
				exercises (*)
			`),

			supabase
				.from("workout_history")
				.select("*")
				.eq("workout_date", todayDateString())
				.maybeSingle(),
		]);

		if (scheduleRes.error) throw scheduleRes.error;
		if (templatesRes.error) throw templatesRes.error;
		if (todayRes.error) throw todayRes.error;

		const templates: Template[] = (templatesRes.data || []).map((t: any) => ({
			id: t.id,
			name: t.name,

			exercises: (t.exercises || []).sort(
				(a: any, b: any) => a.display_order - b.display_order,
			),
		}));

		return {
			schedule: scheduleRes.data || [],

			templates,

			todayLog: todayRes.data || null,
		};
	},

	/* ==================================================
		 SCHEDULE
	  ================================================== */

	async assignTemplateToDay(dayOfWeek: number, templateId: string | null) {
		const { error } = await supabase
			.from("schedule")
			.update({
				template_id: templateId,
				updated_at: new Date().toISOString(),
			})
			.eq("day_of_week", dayOfWeek);

		if (error) throw error;
	},

	/* ==================================================
		 TEMPLATE CRUD
	  ================================================== */

	async createTemplate(name: string): Promise<Template | null> {
		const { data, error } = await supabase
			.from("templates")
			.insert([
				{
					name: name.trim(),
				},
			])
			.select()
			.single();

		if (error) throw error;

		if (!data) return null;

		return {
			...data,
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

	/* ==================================================
		 EXERCISES
	  ================================================== */

	async addExerciseToTemplate(
		templateId: string,
		name: string,
		sets: number,
		reps: number,
		increment: number,
		type: "reps" | "time",
		minutes: number,
		seconds: number,
	) {
		const { data: existing } = await supabase
			.from("exercises")
			.select("display_order")
			.eq("template_id", templateId);

		const nextOrder =
			existing && existing.length > 0
				? Math.max(...existing.map((e: any) => e.display_order)) + 1
				: 0;

		const { error } = await supabase.from("exercises").insert([
			{
				template_id: templateId,

				name: name.trim(),

				exercise_type: type,

				target_sets: sets,

				target_reps: type === "reps" ? reps : 0,

				target_minutes: type === "time" ? minutes : 0,

				target_seconds: type === "time" ? seconds : 0,

				increment: increment,

				current_weight: null,

				display_order: nextOrder,
			},
		]);

		if (error) throw error;
	},

	async deleteExercise(exerciseId: string) {
		const { error } = await supabase
			.from("exercises")
			.delete()
			.eq("id", exerciseId);

		if (error) throw error;
	},

	async saveExerciseBaseline(exerciseId: string, initialWeight: number) {
		const { error } = await supabase
			.from("exercises")
			.update({
				current_weight: initialWeight,
			})
			.eq("id", exerciseId);

		if (error) throw error;
	},

	async updateExerciseOrder(exercises: Exercise[]) {
		await Promise.all(
			exercises.map((exercise, index) =>
				supabase
					.from("exercises")
					.update({
						display_order: index,
					})
					.eq("id", exercise.id),
			),
		);
	},

	/* ==================================================
		 HISTORY
	  ================================================== */

	async skipWorkout(templateId: string | null, templateName?: string | null) {
		const { error } = await supabase.from("workout_history").insert({
			workout_date: todayDateString(),

			template_id: templateId,

			template_name_snapshot: templateName,

			is_skipped: true,

			performance_snapshot: {},

			workout_snapshot: {
				skipped: true,

				template_name: templateName,
			},
		});

		if (error) throw error;
	},

	async submitWorkoutSession(
		template: Template,
		performanceSnapshot: Record<string, any>,
		durationSeconds: number,
	) {
		const workoutSnapshot = {
			template_name: template.name,

			duration_seconds: durationSeconds,

			exercises: template.exercises.map((ex) => {
				if (ex.exercise_type === "reps") {
					const performedSets: (number | null)[] = [];

					for (let s = 0; s < ex.target_sets; s++) {
						performedSets.push(
							performanceSnapshot.reps?.[`${ex.id}-${s}`] ?? null,
						);
					}

					const success = performedSets.every(
						(r) => r !== null && r >= ex.target_reps,
					);

					return {
						id: ex.id,

						name: ex.name,

						exercise_type: ex.exercise_type,

						target_sets: ex.target_sets,

						target_reps: ex.target_reps,

						increment: ex.increment,

						weight_before: ex.current_weight,

						performed_sets: performedSets,

						weight_after: success
							? Number(ex.current_weight ?? 0) + Number(ex.increment)
							: ex.current_weight,
					};
				}

				return {
					id: ex.id,

					name: ex.name,

					exercise_type: "time",

					target_sets: ex.target_sets,

					target_minutes: ex.target_minutes,

					target_seconds: ex.target_seconds,

					performed_times: Array.from({ length: ex.target_sets }, (_, s) => {
						const entry = performanceSnapshot.times?.[`${ex.id}-${s}`];
						return entry ? entry.result : null;
					}),
				};
			}),
		};

		const { error } = await supabase.from("workout_history").insert({
			workout_date: todayDateString(),

			template_id: template.id,

			template_name_snapshot: template.name,

			is_skipped: false,

			performance_snapshot: performanceSnapshot,

			workout_snapshot: workoutSnapshot,
		});

		if (error) throw error;

		const weightUpdates = template.exercises
			.filter((ex) => ex.exercise_type === "reps" && ex.current_weight !== null)
			.map((ex) => {
				let success = true;

				for (let s = 0; s < ex.target_sets; s++) {
					const actual = performanceSnapshot.reps?.[`${ex.id}-${s}`];

					if (actual === undefined || actual < ex.target_reps) {
						success = false;
						break;
					}
				}

				const nextWeight = success
					? Number(ex.current_weight) + Number(ex.increment)
					: ex.current_weight;

				return supabase
					.from("exercises")
					.update({
						current_weight: nextWeight,
					})
					.eq("id", ex.id);
			});

		await Promise.all(weightUpdates);
	},

	async deleteWorkoutLog() {
		const { error } = await supabase
			.from("workout_history")
			.delete()
			.eq("workout_date", todayDateString());
		if (error) throw error;
	},

	/* log a rest day explicitly for a (past) date, for historical accuracy */
	async logRestForDate(dateStr: string) {
		const { error } = await supabase.from("workout_history").insert({
			workout_date: dateStr,
			template_id: null,
			template_name_snapshot: null,
			is_skipped: false,
			performance_snapshot: {},
			workout_snapshot: {
				is_rest: true,
			},
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

	/* load log for arbitrary date (for week box past/future viewing) */
	async getLogForDate(dateStr: string) {
		const { data, error } = await supabase
			.from("workout_history")
			.select("*")
			.eq("workout_date", dateStr)
			.maybeSingle();
		if (error) throw error;
		return data || null;
	},
};
