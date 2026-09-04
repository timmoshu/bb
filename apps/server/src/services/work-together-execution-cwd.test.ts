import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveConfiguredWorkTogetherCwdRoot,
  resolveWorkTogetherExecutionCwd,
} from "./work-together-execution-cwd.js";

const cleanups: string[] = [];

async function temp(prefix: string) {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("Work Together admitted execution cwd", () => {
  it("accepts exact environment cwd or a canonical managed child", async () => {
    const managedRoot = await temp("bb-wt-cwd-root-");
    const admitted = path.join(managedRoot, "workspace", "work");
    await mkdir(admitted, { recursive: true });
    const environmentPath = await temp("bb-wt-environment-");

    expect(resolveConfiguredWorkTogetherCwdRoot(managedRoot)).toBe(managedRoot);
    expect(() => resolveConfiguredWorkTogetherCwdRoot("/")).toThrow(
      "BB_WT_WORK_CWD_ROOT_invalid",
    );
    expect(() => resolveConfiguredWorkTogetherCwdRoot(homedir())).toThrow(
      "BB_WT_WORK_CWD_ROOT_invalid",
    );

    expect(
      resolveWorkTogetherExecutionCwd({
        candidate: environmentPath,
        environmentPath,
        managedRoot: undefined,
      }),
    ).toBe(environmentPath);
    expect(
      resolveWorkTogetherExecutionCwd({
        candidate: admitted,
        environmentPath,
        managedRoot,
      }),
    ).toBe(admitted);
  });

  it("rejects root, HOME, outside, sibling, missing, files, and symlink components safely", async () => {
    const managedRoot = await temp("bb-wt-cwd-root-");
    const admitted = path.join(managedRoot, "workspace", "work");
    await mkdir(admitted, { recursive: true });
    const environmentPath = await temp("bb-wt-environment-");
    const outside = await temp("bb-wt-outside-");
    const sibling = `${managedRoot}-sibling`;
    await mkdir(sibling);
    cleanups.push(sibling);
    const file = path.join(managedRoot, "file");
    await writeFile(file, "not a directory");
    const linked = path.join(managedRoot, "linked");
    await symlink(outside, linked);

    for (const candidate of [
      "/",
      homedir(),
      managedRoot,
      outside,
      sibling,
      path.join(managedRoot, "missing"),
      file,
      linked,
      path.join(linked, "nested"),
    ]) {
      let message = "";
      try {
        resolveWorkTogetherExecutionCwd({
          candidate,
          environmentPath,
          managedRoot,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Coordination cwd unavailable");
      expect(message).not.toContain(candidate);
    }
    for (const forbiddenEnvironmentPath of ["/", homedir()]) {
      expect(() =>
        resolveWorkTogetherExecutionCwd({
          candidate: forbiddenEnvironmentPath,
          environmentPath: forbiddenEnvironmentPath,
          managedRoot: undefined,
        }),
      ).toThrowError("Coordination cwd unavailable");
    }
  });

  it("rejects a managed child after a symlink retarget", async () => {
    const managedRoot = await temp("bb-wt-cwd-root-");
    const admitted = path.join(managedRoot, "workspace", "work");
    await mkdir(admitted, { recursive: true });
    const environmentPath = await temp("bb-wt-environment-");
    expect(
      resolveWorkTogetherExecutionCwd({
        candidate: admitted,
        environmentPath,
        managedRoot,
      }),
    ).toBe(admitted);

    const moved = `${admitted}-moved`;
    await rename(admitted, moved);
    await symlink(await temp("bb-wt-retarget-"), admitted);
    expect(() =>
      resolveWorkTogetherExecutionCwd({
        candidate: admitted,
        environmentPath,
        managedRoot,
      }),
    ).toThrow("Coordination cwd unavailable");
  });
});
