import { createClient } from "@supabase/supabase-js";
import { json, type RequestHandler } from "@sveltejs/kit";
import {
	PUBLIC_SUPABASE_ANON_KEY,
	PUBLIC_SUPABASE_URL,
} from "$env/static/public";
import { env } from "$env/dynamic/private";

const USER_DATA_TABLES = [
	"exercises",
	"workout_history",
	"templates",
	"schedule",
	"usernames",
] as const;

export const POST: RequestHandler = async ({ request }) => {
	const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!serviceRoleKey) {
		return json(
			{
				error:
					"Server missing SUPABASE_SERVICE_ROLE_KEY. Run supabase/setup.sql in the SQL editor instead.",
			},
			{ status: 503 },
		);
	}

	const token = request.headers
		.get("Authorization")
		?.replace(/^Bearer\s+/i, "")
		?.trim();
	if (!token) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const userClient = createClient(
		PUBLIC_SUPABASE_URL,
		PUBLIC_SUPABASE_ANON_KEY,
		{
			auth: {
				autoRefreshToken: false,
				persistSession: false,
			},
			global: { headers: { Authorization: `Bearer ${token}` } },
		},
	);

	const {
		data: { user },
		error: userErr,
	} = await userClient.auth.getUser();
	if (userErr || !user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const admin = createClient(PUBLIC_SUPABASE_URL, serviceRoleKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	try {
		for (const table of USER_DATA_TABLES) {
			const { error } = await admin.from(table).delete().eq("user_id", user.id);
			if (error && error.code !== "PGRST205") {
				throw error;
			}
		}
		const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);
		if (deleteErr) {
			return json({ error: deleteErr.message }, { status: 500 });
		}
	} catch (e) {
		const message =
			e && typeof e === "object" && "message" in e
				? String(e.message)
				: "Delete failed";
		return json({ error: message }, { status: 500 });
	}

	return json({ ok: true });
};