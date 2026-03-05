import * as Sentry from "@sentry/bun";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { apiKeys, users } from "../db/schema";

const GITHUB_KEYS_URI =
	"https://api.github.com/meta/public_keys/secret_scanning";

type GitHubPublicKey = {
	key_identifier: string;
	key: string;
	is_current: boolean;
};

type GitHubPublicKeysResponse = {
	public_keys: GitHubPublicKey[];
};

type SecretMatch = {
	token: string;
	type: string;
	url: string;
	source: string;
};

type FeedbackLabel = "true_positive" | "false_positive";

let cachedKeys: GitHubPublicKeysResponse | null = null;
let cachedKeysAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getGitHubPublicKeys(): Promise<GitHubPublicKeysResponse> {
	if (cachedKeys && Date.now() - cachedKeysAt < CACHE_TTL_MS) {
		return cachedKeys;
	}

	const response = await fetch(GITHUB_KEYS_URI, {
		headers: {
			Accept: "application/json",
			"User-Agent": "HackClub-AI-Secret-Scanning",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch GitHub public keys: ${response.status}`,
		);
	}

	cachedKeys = (await response.json()) as GitHubPublicKeysResponse;
	cachedKeysAt = Date.now();
	return cachedKeys;
}

async function verifyGitHubSignature(
	payload: string,
	signature: string,
	keyId: string,
): Promise<boolean> {
	const keys = await getGitHubPublicKeys();
	const publicKey = keys.public_keys.find((k) => k.key_identifier === keyId);

	if (!publicKey) {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"spki",
		pemToArrayBuffer(publicKey.key),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);

	const signatureBytes = Uint8Array.from(atob(signature), (c) =>
		c.charCodeAt(0),
	);
	const payloadBytes = new TextEncoder().encode(payload);

	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		signatureBytes,
		payloadBytes,
	);
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
	const base64 = pem
		.replace(/-----BEGIN PUBLIC KEY-----/, "")
		.replace(/-----END PUBLIC KEY-----/, "")
		.replace(/\s/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

const REVOKER_API_URL =
	"https://revoke.hackclub.com/api/v1/revocations";

async function notifyRevoker(secret: SecretMatch): Promise<void> {
	const source = secret.source.replaceAll("_", " ");
	const parts = [
		`GitHub Secret Scanning detected a leaked ${secret.type} in ${source}`,
	];
	if (secret.url) {
		parts.push(secret.url);
	}
	const comment = parts.join("\n");

	await fetch(REVOKER_API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			token: secret.token,
			submitter: "github-secret-scanning",
			comment,
		}),
	});
}

const ghss = new Hono();

ghss.post("/", async (c) => {
	const keyId = c.req.header("Github-Public-Key-Identifier");
	const signature = c.req.header("Github-Public-Key-Signature");

	if (!keyId || !signature) {
		return c.json({ error: "Missing signature headers" }, 400);
	}

	const rawBody = await c.req.text();

	const isValid = await verifyGitHubSignature(rawBody, signature, keyId);
	if (!isValid) {
		return c.json({ error: "Invalid signature" }, 403);
	}

	const secrets: SecretMatch[] = JSON.parse(rawBody);
	const results: {
		token_raw: string;
		token_type: string;
		label: FeedbackLabel;
	}[] = [];

	for (const secret of secrets) {
		const [result] = await Sentry.startSpan(
			{ name: "db.select.ghss.apiKeyWithOwner" },
			async () => {
				return await db
					.select({
						apiKeyId: apiKeys.id,
						keyName: apiKeys.name,
						revokedAt: apiKeys.revokedAt,
						ownerEmail: users.email,
					})
					.from(apiKeys)
					.innerJoin(users, eq(apiKeys.userId, users.id))
					.where(eq(apiKeys.key, secret.token))
					.limit(1);
			},
		);

		if (!result) {
			results.push({
				token_raw: secret.token,
				token_type: secret.type,
				label: "false_positive",
			});
			continue;
		}

		if (!result.revokedAt) {
			await Sentry.startSpan(
				{ name: "db.update.ghss.revokeApiKey" },
				async () => {
					await db
						.update(apiKeys)
						.set({ revokedAt: new Date() })
						.where(eq(apiKeys.id, result.apiKeyId));
				},
			);

			await notifyRevoker(secret).catch((err) => {
				Sentry.captureException(err);
			});
		}

		results.push({
			token_raw: secret.token,
			token_type: secret.type,
			label: "true_positive",
		});
	}

	return c.json(results);
});

export default ghss;
