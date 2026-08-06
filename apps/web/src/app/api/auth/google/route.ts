import { redirect } from "next/navigation";
import { getPooledDb } from "@wallop/db";
import { beginGoogleLogin } from "@wallop/core";
import { googleClient } from "@/lib/google";

export async function GET() {
  const { url } = await beginGoogleLogin(getPooledDb(), googleClient());
  redirect(url.toString());
}
