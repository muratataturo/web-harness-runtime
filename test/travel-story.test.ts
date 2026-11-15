import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newTask } from "../src/runtime.js";
import { addEvidence } from "../src/evidence.js";
import {
  validateVisualArtifact,
  assessVisualArtifact,
} from "../src/visual-artifact.js";
import {
  inspectAnswerPhoto,
  prepareAnswerMedia,
  copyAnswerMedia,
} from "../src/answer-media.js";
import { sharedMapEmbed } from "../src/map-embed.js";
import { extractPublicHtml } from "../src/html-reader.js";
import { renderAnswerHtml } from "../src/answer-html.js";
import { mapTile } from "./fixtures/map-tile.mjs";
function travel() {
  const t = newTask({
    query: "上野の一日行程",
    urls: ["https://www.hotpepper.jp/strJ001100102/"],
    maxSteps: 30,
    maxPages: 8,
    timeoutSeconds: 30,
  });
  for (let i = 0; i < 2; i++) {
    const p = {
      id: "p" + i,
      url: "https://www.hotpepper.jp/strJ00110010" + i + "/",
      title: "施設" + i,
      text: `施設の公開案内 latitude=${35.714 + i * 0.001} longitude=139.777`,
      images: [
        { url: "https://imgfp.hotp.jp/photo" + i + ".png", alt: "施設の写真" },
      ],
      capturedAt: t.createdAt,
      links: [],
      truncated: false,
    };
    t.pages.push(p);
    addEvidence(t, p.id, p.text);
  }
  const steps = [0, 1].map((i) => ({
    id: "s" + i,
    when: "10:00",
    where: "施設" + i,
    action: "観察",
    how: "展示を比較して特徴を話す",
    doneWhen: "特徴を一つ話せた",
    locationStatus: "unconfirmed" as const,
    evidenceIds: ["ev-" + (i + 1)],
    costItemIds: [],
  }));
  t.answer = {
    summary: "写真と体験の提案",
    candidates: [],
    limitations: ["当日の公開は未確認"],
    actionPlan: { steps, branches: [] },
    visualArtifact: {
      kind: "journey-map",
      title: "旅の体験",
      description: "保存された根拠からの提案",
      stops: steps.map((s, i) => ({
        id: "stop" + i,
        label: s.where,
        stepIds: [s.id],
        primaryStepId: s.id,
        evidenceIds: s.evidenceIds,
        optional: !!i,
        coordinates: {
          lat: 35.714 + i * 0.001,
          lon: 139.777,
          evidenceId: "ev-" + (i + 1),
        },
        experience: {
          headline: "違いを発見する",
          why: "自分の興味を確かめる体験として提案",
          highlights: [
            "公開案内を確認して観察対象を選ぶ",
            "見つけた特徴を話す",
          ],
          photoPageId: "p" + i,
          photoIndex: 0,
          photoDescription: "検査用の合成写真",
          photoCaption: "掲載元の参考画像で当日の提供を保証しません",
        },
      })),
    },
  };
  return t;
}
test("only Google shared embeds are accepted; arbitrary iframe URLs and API keys are rejected", () => {
  const url = "https://www.google.com/maps/embed?pb=!1m18!2d139.77";
  assert.equal(sharedMapEmbed(url), url);
  for (const bad of [
    "http://www.google.com/maps/embed?pb=!a",
    "https://evil.example/maps/embed?pb=!a",
    "https://www.google.com/maps/embed/v1/place?key=secret",
    "https://www.google.com/maps/embed?pb=!a&key=secret",
    "https://www.google.com/maps/embed?pb=!a#x",
  ])
    assert.equal(sharedMapEmbed(bad), null);
  const p = extractPublicHtml(
    `<iframe src="${url}"></iframe><iframe src="http://%"></iframe><img src="/photo.svg"><main><img src="/photo.jpg" alt="写真"></main>`,
    "https://www.hotpepper.jp/strJ001100102/",
    ["www.hotpepper.jp"],
  );
  assert.deepEqual(p.mapEmbeds, [url]);
  assert.equal(p.images?.length, 1);
});
test("a photo must actually be shown before selection; missing main activities cannot be dropped to pass", async () => {
  const t = travel(),
    dir = await mkdtemp(join(tmpdir(), "story-review-"));
  try {
    assert.throws(
      () => validateVisualArtifact(t, t.answer!.visualArtifact!),
      /inspect_photo/,
    );
    for (let i = 0; i < 2; i++) {
      const result = await inspectAnswerPhoto(t, dir, "p" + i, 0, async () => ({
        bytes: mapTile,
        type: "image/png",
        sourceUrl: "https://imgfp.hotp.jp/fixture.png",
      }));
      assert.equal(result.content[1].type, "image");
      assert.equal(result.content[1].data, mapTile.toString("base64"));
    }
    validateVisualArtifact(t, t.answer!.visualArtifact!);
    assert.equal(assessVisualArtifact(t, t.answer!).status, "passed");
    await prepareAnswerMedia(t, dir);
    assert.equal(Object.keys(t.answerPhotos!).length, 2);
    const out = join(dir, "export", "answer.html");
    await copyAnswerMedia(t, dir, out);
    const file = t.answerPhotos!.stop0!.file;
    assert.deepEqual(
      await readFile(join(dir, "export", "answer-assets", file)),
      mapTile,
    );
    const html = renderAnswerHtml(t);
    assert.match(html, /experience-card/);
    assert.match(html, /answer-assets\//);
    assert.match(html, /frame-src https:\/\/www.google.com/);
    await writeFile(join(dir, "answer-assets", file), "tampered");
    await assert.rejects(copyAnswerMedia(t, dir, out), /完全性/);
    const a = t.answer!.visualArtifact!;
    if (a.kind === "journey-map") {
      delete a.stops[1]!.experience;
      assert.ok(
        assessVisualArtifact(t, t.answer!).issues.some((i) =>
          i.includes("主要な訪問先"),
        ),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
