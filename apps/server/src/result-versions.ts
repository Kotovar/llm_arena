import { resultShaSchema } from "@llm-arena/shared";

type StoredResult = {
  status: string;
  result_json: string | null;
  artifact_path: string;
};

type StoredFollowup = StoredResult & {
  id: string;
  position: number;
};

export type StoredTaskRun = StoredResult & {
  id: string;
  selected_followup_id: string | null;
  followups: StoredFollowup[];
};

export type ResultVersion = {
  type: "initial" | "followup";
  followupId: string | null;
  resultSha: string;
  status: "completed";
  index: number;
};

export type ResultVersionRecord = ResultVersion & {
  artifactPath: string;
  baselineSha: string;
};

export type SelectedResultVersionRecord = ResultVersionRecord & {
  resultJson: string | null;
};

function artifactShas(resultJson: string | null): { baselineSha: string; resultSha: string } | undefined {
  if (!resultJson) return undefined;
  try {
    const artifacts = (JSON.parse(resultJson) as { artifacts?: { baselineSha?: unknown; resultSha?: unknown } }).artifacts;
    if (typeof artifacts?.baselineSha !== "string" || typeof artifacts.resultSha !== "string") return undefined;
    const baseline = resultShaSchema.safeParse(artifacts.baselineSha);
    const result = resultShaSchema.safeParse(artifacts.resultSha);
    if (!baseline.success || !result.success) return undefined;
    return { baselineSha: baseline.data.toLowerCase(), resultSha: result.data.toLowerCase() };
  } catch {
    return undefined;
  }
}

function record(
  source: StoredResult,
  version: Omit<ResultVersion, "resultSha">,
): ResultVersionRecord | undefined {
  if (source.status !== "completed") return undefined;
  const shas = artifactShas(source.result_json);
  return shas ? { ...version, ...shas, artifactPath: source.artifact_path } : undefined;
}

export function completedResultVersions(taskRun: StoredTaskRun): ResultVersionRecord[] {
  const initial = record(taskRun, { type: "initial", followupId: null, status: "completed", index: 0 });
  const followups = taskRun.followups.flatMap((followup) => {
    const version = record(followup, {
      type: "followup",
      followupId: followup.id,
      status: "completed",
      index: followup.position,
    });
    return version ? [version] : [];
  });
  return initial ? [initial, ...followups] : followups;
}

export function selectedResultVersion(taskRun: StoredTaskRun): ResultVersion | null {
  const selected = selectedResultVersionRecord(taskRun);
  if (!selected) return null;
  const { artifactPath: _, baselineSha: __, resultJson: ___, ...version } = selected;
  return version;
}

export function selectedResultVersionRecord(taskRun: StoredTaskRun): SelectedResultVersionRecord | undefined {
  const versions = completedResultVersions(taskRun);
  const version = versions.find((item) => item.followupId === taskRun.selected_followup_id)
    ?? versions.find((version) => version.type === "initial");
  if (!version) return undefined;
  const source = version.followupId
    ? taskRun.followups.find((followup) => followup.id === version.followupId)
    : taskRun;
  return source ? { ...version, resultJson: source.result_json } : undefined;
}

export function resolveCompletedResultVersion(taskRun: StoredTaskRun, resultSha: string): ResultVersionRecord {
  const parsed = resultShaSchema.safeParse(resultSha);
  if (!parsed.success) throw new Error("Invalid result SHA");
  const version = completedResultVersions(taskRun).find((item) => item.resultSha === parsed.data.toLowerCase());
  if (!version) throw new Error("Result SHA is not a completed version");
  return version;
}
