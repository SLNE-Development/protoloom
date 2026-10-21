import { PageSkeleton } from "@/components/status-page";

/** Shown while an app page loads its data on the server. */
export default function Loading() {
  return <PageSkeleton />;
}
