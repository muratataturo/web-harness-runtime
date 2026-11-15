import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import L from "leaflet";
import { visitCurve } from "./journey-geometry.js";
import { backgroundFor, verifiedTileLayer } from "./map-background.js";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "leaflet/dist/leaflet.css";
import "./artifact.css";
const data = JSON.parse(document.getElementById("visual-data").textContent);
const yen = (n) => Math.round(n).toLocaleString("ja-JP");
const searchUrl = (s) =>
  "https://www.google.com/maps/search/?" +
  new URLSearchParams({
    api: "1",
    query: s.coordinates
      ? `${s.coordinates.lat},${s.coordinates.lon}`
      : s.label,
  });
function routeUrl(stops) {
  // Google Maps mobile supports up to three waypoints. Never silently omit stops.
  if (stops.length > 5) return null;
  return (
    "https://www.google.com/maps/dir/?" +
    new URLSearchParams({
      api: "1",
      origin: stops[0].coordinates
        ? `${stops[0].coordinates.lat},${stops[0].coordinates.lon}`
        : stops[0].label,
      destination: stops.at(-1).coordinates
        ? `${stops.at(-1).coordinates.lat},${stops.at(-1).coordinates.lon}`
        : stops.at(-1).label,
      waypoints: stops
        .slice(1, -1)
        .map((s) =>
          s.coordinates ? `${s.coordinates.lat},${s.coordinates.lon}` : s.label,
        )
        .join("|"),
      travelmode: "walking",
    })
  );
}
function citations(ids) {
  return ids.map((id) => (
    <a key={id} href={"#source-" + data.evidence.findIndex((e) => e.id === id)}>
      {id}
    </a>
  ));
}
function Journey() {
  const a = data.artifact,
    [optional, setOptional] = useState(true),
    [active, setActive] = useState(
      a.stops.find((s) => data.previews?.[s.id])?.id ?? a.stops[0].id,
    ),
    [mapMode, setMapMode] = useState(
      Object.keys(data.previews ?? {}).length ? "google" : "route",
    ),
    [googleLoaded, setGoogleLoaded] = useState(false),
    [googleUnavailable, setGoogleUnavailable] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [tiles, setTiles] = useState(0),
    [tilesPending, setTilesPending] = useState(false),
    [backgroundError, setBackgroundError] = useState(null);
  const container = useRef(),
    mapRef = useRef(),
    layers = useRef(),
    backgroundLayer = useRef(),
    backgroundStopped = useRef(false),
    visibleCoordinates = useRef([]),
    boundsKey = useRef(""),
    selected = a.stops.filter((s) => optional || !s.optional);
  const selectedStop = selected.find((s) => s.id === active) ?? selected[0];
  const steps = (s) => data.plan.steps.filter((t) => s.stepIds.includes(t.id));
  const primary = (s) => data.plan.steps.find((t) => t.id === s.primaryStepId);
  const preview = data.previews?.[selectedStop.id];
  const chooseStop = (id) => {
    setActive(id);
    setGoogleLoaded(false);
    setGoogleUnavailable(false);
    setMapMode(data.previews?.[id] && navigator.onLine ? "google" : "route");
  };
  const provider = backgroundFor(a.stops);
  const mapped = selected.filter((s) => s.coordinates),
    unlocated = selected.filter((s) => !s.coordinates);
  useEffect(() => {
    const map = L.map(container.current, {
      scrollWheelZoom: false,
      zoomControl: false,
      attributionControl: true,
    }).setView(
      mapped[0]
        ? [mapped[0].coordinates.lat, mapped[0].coordinates.lon]
        : [0, 0],
      mapped[0] ? 15 : 1,
    );
    mapRef.current = map;
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    map.attributionControl.addAttribution(
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    );
    let failed = false;
    const tile = provider
      ? verifiedTileLayer(L, provider, (reason) => {
          failed = true;
          backgroundStopped.current = true;
          setBackgroundError(reason);
          setTiles(0);
          setTilesPending(false);
          tile.remove();
        })
      : null;
    tile?.on("loading", () => setTilesPending(true));
    tile?.on("load", () => {
      if (!failed) setTilesPending(false);
    });
    tile?.on("tileload", () => {
      if (!failed) setTiles((n) => n + 1);
    });
    backgroundLayer.current = tile;
    if (navigator.onLine && mapped.length && tile && mapMode === "route")
      tile.addTo(map);
    const change = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) setTilesPending(false);
      if (
        navigator.onLine &&
        mapped.length &&
        tile &&
        !failed &&
        !map.hasLayer(tile) &&
        mapMode === "route"
      )
        tile.addTo(map);
    };
    window.addEventListener("online", change);
    window.addEventListener("offline", change);
    layers.current = L.layerGroup().addTo(map);
    const resize = new ResizeObserver(() => {
      map.invalidateSize();
      if (visibleCoordinates.current.length > 1)
        map.fitBounds(visibleCoordinates.current, {
          padding: [45, 45],
          maxZoom: 17,
          animate: false,
        });
    });
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      window.removeEventListener("online", change);
      window.removeEventListener("offline", change);
      map.remove();
    };
  }, []);
  useEffect(() => {
    const tile = backgroundLayer.current,
      map = mapRef.current;
    if (
      mapMode === "route" &&
      tile &&
      map &&
      online &&
      !backgroundStopped.current &&
      !map.hasLayer(tile)
    )
      tile.addTo(map);
  }, [mapMode, online]);
  useEffect(() => {
    if (mapMode !== "google" || !preview || !online) {
      if (mapMode === "google") setMapMode("route");
      return;
    }
    if (googleLoaded) return;
    const timer = setTimeout(() => {
      setGoogleUnavailable(true);
      setMapMode("route");
    }, 8000);
    return () => clearTimeout(timer);
  }, [mapMode, preview?.url, googleLoaded]);
  useEffect(() => {
    const click = (e) => {
      const link = e.target.closest("a[data-map-stop]");
      if (link && a.stops.some((s) => s.id === link.dataset.mapStop))
        chooseStop(link.dataset.mapStop);
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);
  useEffect(() => {
    const group = layers.current,
      map = mapRef.current;
    if (!map || !group) return;
    const coords = mapped.map((s) => [s.coordinates.lat, s.coordinates.lon]);
    visibleCoordinates.current = coords;
    const key = JSON.stringify(coords);
    if (key !== boundsKey.current) {
      boundsKey.current = key;
      if (coords.length > 1)
        map.fitBounds(coords, {
          padding: [55, 55],
          maxZoom: 17,
          animate: false,
        });
      if (coords.length === 1) map.setView(coords[0], 16);
      if (!coords.length) map.setView([0, 0], 1);
    }
    const draw = () => {
      group.clearLayers();
      for (let i = 1; i < coords.length; i++) {
        const curve = visitCurve(map, coords[i - 1], coords[i], i);
        L.polyline(curve, {
          color: "#fffefa",
          weight: 7,
          opacity: 0.95,
          interactive: false,
        }).addTo(group);
        L.polyline(curve, {
          color: "#527c70",
          weight: 2.5,
          dashArray: "4 8",
          opacity: 0.85,
          interactive: false,
        }).addTo(group);
      }
      const groups = new Map();
      mapped.forEach((s) => {
        const k = s.coordinates.lat + "," + s.coordinates.lon;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ stop: s, number: selected.indexOf(s) + 1 });
      });
      const entriesList = [...groups.values()];
      entriesList.forEach((entries, gi) => {
        const s = entries[0].stop,
          source = [s.coordinates.lat, s.coordinates.lon],
          point = map.project(source),
          isActive = entries.some((e) => e.stop.id === selectedStop.id);
        const near = entriesList.findIndex(
          (other, oi) =>
            oi !== gi &&
            map
              .project([
                other[0].stop.coordinates.lat,
                other[0].stop.coordinates.lon,
              ])
              .distanceTo(point) < 48,
        );
        const offset = near < 0 ? 0 : gi < near ? -24 : 24;
        const dock = map.unproject([point.x, point.y + offset]);
        if (offset)
          L.polyline([source, dock], {
            color: "#91aaa0",
            weight: 1.2,
            interactive: false,
          }).addTo(group);
        L.circleMarker(source, {
          radius: 3,
          stroke: false,
          fillColor: "#527c70",
          fillOpacity: 1,
          interactive: false,
        }).addTo(group);
        const marker = L.marker(dock, {
          icon: L.divIcon({
            className: "journey-pin" + (isActive ? " selected" : ""),
            html:
              "<span><b>" +
              entries.map((e) => e.number).join("·") +
              "</b></span>",
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
          title: s.label,
          keyboard: true,
          alt: s.label,
          zIndexOffset: isActive ? 1000 : 0,
        }).addTo(group);
        marker.on("click", () => chooseStop(s.id));
        marker.getElement()?.setAttribute("aria-label", s.label + "を選択");
        const label = document.createElement("div"),
          name = document.createElement("strong"),
          time = document.createElement("small");
        name.textContent = s.label.includes("・")
          ? s.label.split("・").slice(1).join("・")
          : s.label;
        time.textContent = entries
          .map((e) => primary(e.stop)?.when)
          .filter(Boolean)
          .join(" / ");
        label.append(time, name);
        const direction =
          map.latLngToContainerPoint(dock).x > map.getSize().x * 0.55
            ? "left"
            : "right";
        marker.bindTooltip(label, {
          permanent: true,
          direction,
          offset: [direction === "left" ? -19 : 19, 0],
          className: "journey-place-label" + (isActive ? " is-selected" : ""),
          opacity: 1,
        });
      });
    };
    draw();
    map.on("zoomend", draw);
    return () => map.off("zoomend", draw);
  }, [optional, active]);
  const cost = data.plan.budget;
  const excluded = optional
    ? new Set()
    : new Set(
        a.stops
          .filter((s) => s.optional)
          .flatMap((s) => steps(s).flatMap((t) => t.costItemIds)),
      );
  const retained = new Set(
    selected.flatMap((s) => steps(s).flatMap((t) => t.costItemIds)),
  );
  const saved =
    cost?.items
      .filter((i) => excluded.has(i.id) && !retained.has(i.id))
      .reduce((n, i) => n + i.quantity * i.unitYen, 0) ?? 0;
  const route = routeUrl(selected);
  const related = steps(selectedStop),
    budget = cost ? cost.totalYen - saved : null;
  return (
    <div className="journey-workspace" data-artifact-kind="journey-map">
      <div className="visual-heading">
        <div>
          <p className="overline">A DAY, DRAWN OUT</p>
          <h2>{a.title}</h2>
          <p>{a.description}</p>
        </div>
        <Badge label="当日の利用は未確認" variant="yellow" />
      </div>
      <div className="journey-layout">
        <div className="journey-map-area">
          <div className="map-modebar">
            <div>
              <Button
                label="Google Maps"
                variant={mapMode === "google" ? "primary" : "secondary"}
                isDisabled={!preview || !online}
                onClick={() => {
                  setGoogleLoaded(false);
                  setGoogleUnavailable(false);
                  setMapMode("google");
                }}
              />
              <Button
                label="行程マップ"
                variant={mapMode === "route" ? "primary" : "secondary"}
                onClick={() => setMapMode("route")}
              />
            </div>
            <small>
              {mapMode === "google"
                ? "選択地点のGoogle Mapsプレビュー"
                : "地物に基づく参考地図・訪問順の概略"}
            </small>
          </div>
          <div className="map-stage">
            <div
              ref={container}
              className="journey-map"
              data-tiles-ready={tiles > 0}
              data-map-loading={tilesPending}
              aria-label="行程の地図。番号ピンで予定を選択"
            />
            {mapMode === "route" &&
              (!tiles || tilesPending || backgroundError) && (
                <div className="map-fallback-note" role="status">
                  {backgroundError
                    ? `背景地図を表示できません（${backgroundError}）。`
                    : !provider
                      ? "この地域の背景地図には未対応です。"
                      : !online
                        ? "オフラインのため背景地図を取得できません。"
                        : "背景地図を読み込み中。"}
                  ピンは出典座標、破線は訪問順の概略です。
                  {(!provider || backgroundError || !online) && (
                    <a
                      href={routeUrl(selected) ?? searchUrl(selectedStop)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Google Mapsで確認 ↗
                    </a>
                  )}
                </div>
              )}
            {mapMode === "google" && preview && (
              <div className="google-map-preview">
                <iframe
                  key={preview.url}
                  title={`${selectedStop.label}のGoogle Mapsプレビュー`}
                  src={preview.url}
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                  onLoad={() => setGoogleLoaded(true)}
                  ref={(node) => {
                    if (node)
                      node.onerror = () => {
                        setGoogleUnavailable(true);
                        setMapMode("route");
                      };
                  }}
                />
                {!googleLoaded && (
                  <div className="google-map-loading">
                    Google Mapsを読み込み中…
                  </div>
                )}
              </div>
            )}
            {mapMode === "route" && (
              <div className="map-view-tag">
                <span>旅の見取り図</span>
                <small>場所を選んで詳細へ</small>
              </div>
            )}
          </div>
          <div className="map-caption">
            <span className="route-key" />
            {mapMode === "google" ? (
              <>
                <a
                  href={preview?.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  施設公式ページの共有地図
                </a>
                <button
                  className="map-switch-fallback"
                  onClick={() => setMapMode("route")}
                >
                  表示されない場合は行程マップへ
                </button>
              </>
            ) : (
              <>
                {googleUnavailable
                  ? "Google Mapsを表示できないため、参考地図に切り替えました。"
                  : ""}
                点線は立寄り順のイメージです。歩行経路はGoogle
                Mapsで確認できます。
              </>
            )}
          </div>
          <div className="map-selection" aria-live="polite">
            <span className="overline">SELECTED STOP</span>
            <h3>{selectedStop.label}</h3>
            <p>
              {primary(selectedStop)?.when} ·{" "}
              {related.map((t) => t.action).join(" / ")}
            </p>
            <p>{primary(selectedStop)?.how}</p>
            <a
              href={searchUrl(selectedStop)}
              target="_blank"
              rel="noopener noreferrer"
            >
              この場所をGoogle Mapsで確認 ↗
            </a>
            <div className="visual-refs">
              {citations([
                ...new Set([
                  ...selectedStop.evidenceIds,
                  ...(selectedStop.coordinates
                    ? [selectedStop.coordinates.evidenceId]
                    : []),
                ]),
              ])}
            </div>
          </div>
        </div>
        <aside className="journey-planner">
          <div className="planner-top">
            <span className="overline">YOUR ITINERARY</span>
            <span>{selected.length}地点</span>
          </div>
          {a.stops.some((s) => s.optional) && (
            <div className="plan-toggle">
              <Button
                label={optional ? "任意の立寄りを省く" : "任意の立寄りを戻す"}
                variant="secondary"
                onClick={() => {
                  setOptional(!optional);
                  setActive(a.stops[0].id);
                }}
                aria-pressed={!optional}
              />
              <small>
                表示と費用だけを比較。省略後の時刻は再計算しません。
              </small>
            </div>
          )}
          <ol className="stop-list">
            {selected.map((s, i) => (
              <li key={s.id}>
                <button
                  className={
                    "stop-choice " +
                    (selectedStop.id === s.id ? "is-active" : "")
                  }
                  aria-pressed={selectedStop.id === s.id}
                  onClick={() => chooseStop(s.id)}
                >
                  <span className="stop-index">{i + 1}</span>
                  <span>
                    <span className="stop-time">
                      {primary(s)?.when}
                      {s.optional ? " · 任意" : ""}
                    </span>
                    <strong>{s.label}</strong>
                    <small>
                      {primary(s)?.action}
                      {s.coordinates ? "" : " · 座標未取得"}
                    </small>
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="journey-total">
            <span>この案の予算見積</span>
            <strong>{budget !== null ? "¥" + yen(budget) : "未算定"}</strong>
            <small>
              {saved
                ? "任意地点にだけ紐づく費用" + yen(saved) + "円を除外。"
                : ""}
              未確認の見積を含みます。
            </small>
          </div>
          {route ? (
            <Button
              label="全行程をGoogle Mapsで開く ↗"
              variant="primary"
              href={route}
              target="_blank"
              rel="noopener noreferrer"
            />
          ) : (
            <p>
              地点が多いため、各地点のGoogle
              Mapsリンクから区間を確認してください。
            </p>
          )}
          {unlocated.length > 0 && (
            <p className="visual-warning">
              地図未配置：{unlocated.map((s) => s.label).join("、")}
              。座標を確認できていません。
            </p>
          )}
        </aside>
      </div>
      <p className="visual-footnote">
        施設の代表位置を表示。入口・通行可能な道・当日の営業は未確認です。背景地図は日本の範囲をオンライン時に国土地理院から取得します。取得できない場合は、ピンと訪問順の概略表示を残します。
      </p>
    </div>
  );
}
function Roadmap() {
  const a = data.artifact,
    [active, setActive] = useState(a.milestones[0].id),
    [done, setDone] = useState(new Set());
  const horizons = [...new Set(a.milestones.map((m) => m.horizon))],
    byId = new Map(a.milestones.map((m) => [m.id, m])),
    selected = byId.get(active);
  const blocked = (m) => m.dependsOn.some((id) => !done.has(id));
  const candidates = a.milestones.filter((m) => !done.has(m.id) && !blocked(m)),
    next = candidates[0];
  return (
    <div className="roadmap-workspace" data-artifact-kind="life-roadmap">
      <div className="visual-heading">
        <div>
          <p className="overline">MAKE ROOM FOR YOUR NEXT CHAPTER</p>
          <h2>{a.title}</h2>
          <p>{a.description}</p>
        </div>
        <Badge variant="purple" label="将来の予測ではなく提案" />
      </div>
      <div className="roadmap-summary">
        <div>
          <span className="overline">NEXT SMALL STEP</span>
          <h3>{next?.title ?? "すべての節目を確認しました"}</h3>
          <p>{next?.action ?? "前提が変わったら計画を見直しましょう。"}</p>
          {next && (
            <Button
              label="次の一歩を詳しく見る"
              onClick={() => setActive(next.id)}
              variant="primary"
            />
          )}
        </div>
        <div
          className="progress-ring"
          style={{
            "--progress": `${(done.size / a.milestones.length) * 360}deg`,
          }}
        >
          <span>
            <strong>
              {done.size}
              <small> / {a.milestones.length}</small>
            </strong>
            確認した節目
          </span>
        </div>
      </div>
      <div className="roadmap-legend">
        <span>● 着手できる</span>
        <span>◇ 前提の確認待ち</span>
        <span>✓ この画面で完了にした</span>
        <span className="roadmap-scroll-hint">← 時間軸を横にスクロール →</span>
      </div>
      <div
        className="roadmap-scroll"
        tabIndex="0"
        aria-label="横方向にスクロールできる人生ロードマップ"
      >
        <div className="roadmap-board" style={{ "--columns": horizons.length }}>
          <div className="roadmap-corner">領域 / 時間の目安</div>
          {horizons.map((h) => (
            <div className="horizon" key={h}>
              {h}
            </div>
          ))}
          {a.lanes.map((l, li) => (
            <React.Fragment key={l.id}>
              <div className={"lane-label lane-" + li}>
                <span>0{li + 1}</span>
                <strong>{l.label}</strong>
              </div>
              {horizons.map((h) => (
                <div className={"roadmap-cell lane-" + li} key={h}>
                  {a.milestones
                    .filter((m) => m.laneId === l.id && m.horizon === h)
                    .map((m) => (
                      <button
                        key={m.id}
                        className={
                          "milestone " +
                          (m.id === active ? "is-active " : "") +
                          (done.has(m.id) ? "is-done" : "")
                        }
                        onClick={() => setActive(m.id)}
                        aria-pressed={m.id === active}
                      >
                        <span className="milestone-state">
                          {done.has(m.id)
                            ? "✓ 確認済み"
                            : blocked(m)
                              ? "◇ 前提待ち"
                              : "● 着手できる"}
                        </span>
                        <strong>{m.title}</strong>
                        <span className="milestone-outcome">{m.doneWhen}</span>
                        {m.dependsOn.length > 0 && (
                          <small>
                            ←{" "}
                            {m.dependsOn
                              .map((id) => byId.get(id).title)
                              .join("・")}
                          </small>
                        )}
                      </button>
                    ))}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="milestone-detail" aria-live="polite">
        <div>
          <span className="overline">
            {selected.horizon} /{" "}
            {a.lanes.find((l) => l.id === selected.laneId).label}
          </span>
          <h3>{selected.title}</h3>
          <p>{selected.action}</p>
          <div className="milestone-facts">
            <p>
              <b>できたと判断する基準</b>
              {selected.doneWhen}
            </p>
            <p>
              <b>次へ進む・見直す条件</b>
              {selected.decision}
            </p>
          </div>
          <p>
            前提：
            {selected.dependsOn.length
              ? selected.dependsOn.map((id) => (
                  <button
                    className="prerequisite-link"
                    key={id}
                    onClick={() => setActive(id)}
                  >
                    {byId.get(id).title} ↗
                  </button>
                ))
              : "先に終える必要がある節目なし"}
          </p>
          <div className="visual-refs">{citations(selected.evidenceIds)}</div>
        </div>
        <div>
          <Badge
            label={
              selected.basis === "proposal"
                ? "未確認の前提を含む提案"
                : "出典に基づく"
            }
            variant="purple"
          />
          <Button
            label={
              done.has(selected.id) ? "未完了に戻す" : "この節目を完了にする"
            }
            variant="secondary"
            isDisabled={!done.has(selected.id) && blocked(selected)}
            onClick={() =>
              setDone((prev) => {
                const updated = new Set(prev);
                if (updated.has(selected.id)) {
                  updated.delete(selected.id);
                  let changed = true;
                  while (changed) {
                    changed = false;
                    for (const m of a.milestones)
                      if (
                        updated.has(m.id) &&
                        m.dependsOn.some((id) => !updated.has(id))
                      ) {
                        updated.delete(m.id);
                        changed = true;
                      }
                  }
                } else updated.add(selected.id);
                return updated;
              })
            }
          />
          <small>
            進捗はこの画面を開いている間だけ保持します。実際の完了を自動判定しません。
          </small>
        </div>
      </div>
    </div>
  );
}
class ArtifactBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="artifact-fallback" data-artifact-error="true">
        <h2>視覚表示を読み込めませんでした</h2>
        <p>下の行程・回答全文・引用は引き続き確認できます。</p>
        {data.artifact.kind === "journey-map" && (
          <a
            href={
              routeUrl(data.artifact.stops) ?? searchUrl(data.artifact.stops[0])
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Mapsで場所と経路を確認 ↗
          </a>
        )}
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("visual-artifact")).render(
  <ArtifactBoundary>
    {data.artifact.kind === "journey-map" ? <Journey /> : <Roadmap />}
  </ArtifactBoundary>,
);
