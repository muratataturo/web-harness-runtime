import { assessVisualArtifact } from "./visual-artifact.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fetchPreviewImage } from "./visual-preview.js";
import { assetHosts } from "./runtime-profile.js";
import type { Task } from "./types.js";
export { sharedMapEmbed } from "./map-embed.js";
export async function inspectAnswerPhoto(
  task: Task,
  taskDir: string,
  pageId: string,
  index: number,
  fetchImage = fetchPreviewImage,
) {
  if ((task.photoInspections?.length ?? 0) >= 8)
    throw Error("写真確認は1回の生成で8候補までです");
  const page = task.pages.find((p) => p.id === pageId),
    image = page?.images?.[index];
  if (!page || !image) throw Error("保存済みの画像参照が必要です");
  const previous = task.photoInspections?.find(
    (p) => p.pageId === pageId && p.imageIndex === index,
  );
  let photo;
  if (
    previous &&
    /^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/.test(previous.file)
  ) {
    const bytes = await readFile(join(taskDir, "answer-assets", previous.file));
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      previous.file.split(".")[0]
    )
      throw Error("写真の完全性エラー");
    photo = { bytes, type: previous.type, sourceUrl: previous.sourceUrl };
  }
  photo ??= await fetchImage(
    image.url,
    AbortSignal.timeout(8000),
    undefined,
    undefined,
    assetHosts(new URL(page.url).hostname),
  );
  const ext = (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
    } as Record<string, string>
  )[photo.type];
  const file =
    createHash("sha256").update(photo.bytes).digest("hex") + "." + ext;
  await mkdir(join(taskDir, "answer-assets"), { recursive: true });
  await writeFile(join(taskDir, "answer-assets", file), photo.bytes, {
    mode: 0o600,
  });
  if (!previous)
    (task.photoInspections ??= []).push({
      pageId,
      imageIndex: index,
      file,
      sourceUrl: image.url,
      type: photo.type,
      shownAt: new Date().toISOString(),
    });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          pageId,
          imageIndex: index,
          sourceUrl: page.url,
          instruction:
            "実画像を確認し、施設・展示・料理の内容を伝える写真だけを選ぶ。ロゴ・広告・案内バナー・パスポートの画像は体験写真に採用しない。写真が当日の利用可能性や献立の根拠にはならない。",
        }),
      },
      {
        type: "image" as const,
        mimeType: photo.type,
        data: photo.bytes.toString("base64"),
      },
    ],
    details: {},
  };
}
export async function prepareAnswerMedia(task: Task, taskDir: string) {
  const a = task.answer?.visualArtifact;
  if (a?.kind !== "journey-map") return;
  const photos = Object.create(null) as NonNullable<Task["answerPhotos"]>;
  task.answerPhotos = photos;
  for (const stop of a.stops.filter((s) => s.experience).slice(0, 6)) {
    const e = stop.experience!,
      page = task.pages.find((p) => p.id === e.photoPageId),
      image = page?.images?.[e.photoIndex];
    if (!page || !image) continue;
    try {
      const seen = task.photoInspections?.find(
        (p) => p.pageId === e.photoPageId && p.imageIndex === e.photoIndex,
      );
      let photo;
      if (seen && /^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/.test(seen.file)) {
        try {
          const bytes = await readFile(
            join(taskDir, "answer-assets", seen.file),
          );
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            seen.file.split(".")[0]
          )
            throw Error("写真の完全性エラー");
          photo = { bytes, type: seen.type, sourceUrl: seen.sourceUrl };
        } catch {
          /* A missing cache is fetched only from the captured source below. */
        }
      }
      if (!photo) {
        photo = await fetchPreviewImage(
          image.url,
          AbortSignal.timeout(8000),
          undefined,
          undefined,
          assetHosts(new URL(page.url).hostname),
        );
        if (
          seen &&
          createHash("sha256").update(photo.bytes).digest("hex") !==
            seen.file.split(".")[0]
        ) {
          task.photoInspections = task.photoInspections?.filter(
            (p) => p !== seen,
          );
          throw Error("参照画像が変わったため実画像の再確認が必要です");
        }
      }
      const ext = (
        {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
          "image/avif": "avif",
        } as Record<string, string>
      )[photo.type];
      const file =
        createHash("sha256").update(photo.bytes).digest("hex") + "." + ext;
      await mkdir(join(taskDir, "answer-assets"), { recursive: true });
      await writeFile(join(taskDir, "answer-assets", file), photo.bytes, {
        mode: 0o600,
      });
      photos[stop.id] = {
        file,
        pageId: page.id,
        imageIndex: e.photoIndex,
        sourceUrl: image.url,
        type: photo.type,
        capturedAt: new Date().toISOString(),
      };
    } catch {
      (task.reviewWarnings ??= []).push(
        `${stop.label}: 掲載写真を取得できませんでした。写真のない状態を視覚品質の成功には数えません。`,
      );
    }
  }
  task.visualReview = assessVisualArtifact(task, task.answer!);
  if (
    task.visualReview.status === "needs_visual" &&
    task.status === "succeeded"
  )
    task.status = "partial";
}
export async function copyAnswerMedia(
  task: Task,
  taskDir: string,
  outFile: string,
) {
  if (!task.answerPhotos) return;
  const dest = join(dirname(outFile), "answer-assets");
  await mkdir(dest, { recursive: true });
  for (const photo of Object.values(task.answerPhotos)) {
    if (!/^[a-f0-9]{64}\.(jpg|png|webp|gif|avif)$/.test(photo.file))
      throw Error("不正な写真ファイル名");
    const src = join(taskDir, "answer-assets", photo.file);
    const bytes = await readFile(src);
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      photo.file.split(".")[0]
    )
      throw Error("保存写真の完全性を確認できません");
    if (src !== join(dest, photo.file))
      await copyFile(src, join(dest, photo.file));
  }
}
