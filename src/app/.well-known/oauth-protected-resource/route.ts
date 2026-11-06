import { WellKnown } from "@/app/.well-known/handlers";

export const GET = WellKnown.protectedResource;
export const OPTIONS = WellKnown.preflight;
