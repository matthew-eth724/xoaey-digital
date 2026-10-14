import type { APIRoute } from "astro";

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICE_VALUES = new Set(["automation", "website", "both"]);
const BUDGET_VALUES = new Set(["", "under-1k", "1-3k", "3-10k", "10k-plus"]);

// Best-effort per-isolate rate limiting (each Worker isolate keeps its own
// counters; a persistent store is unnecessary for a low-volume contact form).
const hitsByIp = new Map<string, number[]>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

function readToken(context: Parameters<APIRoute>[0]): string | undefined {
	const fromProcess =
		typeof process !== "undefined" ? process.env?.XOAEY_CONTACT_TOKEN : undefined;
	if (fromProcess) return fromProcess;
	const runtime = (context.locals as Record<string, unknown>)?.runtime as
		| { env?: Record<string, string> }
		| undefined;
	return runtime?.env?.XOAEY_CONTACT_TOKEN;
}

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const recent = (hitsByIp.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
	recent.push(now);
	hitsByIp.set(ip, recent);
	return recent.length > RATE_MAX;
}

function fail(context: Parameters<APIRoute>[0], status: number) {
	const wantsJson =
		context.request.headers.get("accept")?.includes("application/json") ?? false;
	if (wantsJson) {
		return new Response(JSON.stringify({ ok: false }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}
	const url = new URL("/contact?error=send", context.url);
	return Response.redirect(url, 303);
}

export const POST: APIRoute = async (context) => {
	const { request, clientAddress } = context;

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return fail(context, 400);
	}

	const str = (key: string) =>
		(form.get(key)?.toString() ?? "").trim().slice(0, 5000);

	// Honeypot: bots fill it, humans never see it.
	if (str("website") !== "") {
		const url = new URL("/contact?sent=1", context.url);
		return Response.redirect(url, 303);
	}

	if (isRateLimited(clientAddress)) {
		return fail(context, 429);
	}

	const name = str("name").slice(0, 120);
	const email = str("email").slice(0, 200);
	const company = str("company").slice(0, 160);
	const service = str("service");
	const budget = str("budget");
	const message = str("message");

	if (
		name.length < 2 ||
		!EMAIL_RE.test(email) ||
		!SERVICE_VALUES.has(service) ||
		!BUDGET_VALUES.has(budget) ||
		message.length < 10
	) {
		return fail(context, 400);
	}

	const token = readToken(context);
	if (!token) {
		console.error(
			"[contact] XOAEY_CONTACT_TOKEN is not set; create an API token in the admin and store it with `wrangler secret put XOAEY_CONTACT_TOKEN`.",
		);
		return fail(context, 500);
	}

	const slug = `inquiry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = new URL("/_emdash/api/content/inquiries", context.url);

	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				slug,
				data: { name, email, company, service, budget, message },
			}),
		});
	} catch (error) {
		console.error("[contact] CMS write failed:", error);
		return fail(context, 500);
	}

	if (!res.ok) {
		console.error("[contact] CMS write rejected:", res.status, await res.text());
		return fail(context, 500);
	}

	const wantsJson =
		request.headers.get("accept")?.includes("application/json") ?? false;
	if (wantsJson) {
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}
	return Response.redirect(new URL("/contact?sent=1", context.url), 303);
};
