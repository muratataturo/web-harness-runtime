"""Portable local evidence report. Inline photographs are small previews, not training assets."""

import base64, html, io, json
from PIL import Image


def thumbnail(path, width=700):
    image = Image.open(path).convert("RGB")
    image.thumbnail((width, 500))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=77, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def write_report(out, result, config, events, viewer=None):
    before = thumbnail(out / "baseline/preview.png")
    after = thumbnail(out / "reconstructed.png")
    overlay = thumbnail(out / "validation-overlays.jpg", 850)
    rounds = "".join(
        f"<tr><td>{r['resolution']}</td><td>{r['voxel_size_mm']:.1f} mm</td><td>{r['mean_iou']:.3f}</td><td>{'採用' if r['adopted'] else '棄却'}</td></tr>"
        for r in result["rounds"]
    )
    timeline = "".join(
        f"<li><b>{html.escape(e['stage'])}</b><span>{e['elapsed_s']:.1f}s</span></li>"
        for e in events
    )
    payload = json.dumps(viewer or {}, separators=(",", ":")).replace("<", "\\u003c")
    document = f'''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vehicle3D — 実行と精度の検証</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#f4f6f8;color:#142b3b;font:15px/1.7 system-ui,sans-serif}}header{{background:#132b3a;color:white;padding:40px max(6vw,20px)}}header small{{color:#72d8dd;letter-spacing:.16em}}h1{{font-size:clamp(28px,4vw,44px);line-height:1.3;margin:10px 0}}header p{{color:#b7c9d2;max-width:800px}}main{{max-width:1200px;margin:auto;padding:26px 20px 60px}}.tag{{display:inline-block;background:#f5deb0;color:#684706;border-radius:20px;padding:4px 14px;font-size:13px}}.stats,.pair,.body{{display:grid;gap:18px}}.stats{{grid-template-columns:repeat(4,1fr);margin:4px 0 24px}}.card,section{{background:white;border:1px solid #dfe6eb;border-radius:14px;padding:22px}}.card b{{font-size:30px;display:block;line-height:1.3}}.card small{{color:#667d8c}}.pair{{grid-template-columns:1fr 1fr}}.pair figure{{margin:0}}img{{width:100%;border-radius:8px}}figcaption{{font-size:13px;color:#536d7c;padding-top:8px}}h2{{margin:0 0 16px;font-size:21px}}h3{{font-size:16px}}.body{{grid-template-columns:2fr 1fr;margin-top:20px}}section{{margin-bottom:20px}}.note{{background:#fff5e2;border-left:4px solid #dfa73b;padding:15px;border-radius:6px}}table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{border-bottom:1px solid #e3e9ed;padding:9px;text-align:left}}li{{margin-bottom:8px}}.events{{list-style:none;padding:0;font-size:12px}}.events li{{display:flex;justify-content:space-between;border-bottom:1px solid #e8edef;padding:6px}}.events span{{color:#688291}}a{{color:#087d89}}canvas{{width:100%;height:380px;display:block;background:#e9f0f3;border-radius:10px;touch-action:none;cursor:grab}}button{{background:#163e50;color:white;border:0;padding:8px 16px;border-radius:7px;cursor:pointer}}code{{font-size:12px;background:#e9eef2;padding:2px 5px}}footer{{font-size:12px;color:#687f8d}}@media(max-width:700px){{.stats{{grid-template-columns:1fr 1fr}}.pair,.body{{grid-template-columns:1fr}}header{{padding:25px 20px}}canvas{{height:300px}}}}</style>
<header><small>VEHICLE3D / AUTONOMOUS RECONSTRUCTION</small><h1>写真から、検証可能な3Dへ。</h1><p>公式360°画像を使って形状を復元し、未使用の視点で照合。計測・採用・棄却を記録した実行結果です。</p><span class="tag">実車の精密CADとしては未認証</span></header>
<main><section class="note"><h2>画像として一致していません</h2><p>このページは輪郭の補助評価です。完成品質の根拠には使いません。<a href="image-audit.html">実レンダリングのPSNR・SSIM、元画像との比較、差分画像を見る</a>。</p></section><div class="stats"><div class="card"><small>補助：最終テストの輪郭IoU</small><b>{result["final_test"]["baseline"]["mean_iou"]:.3f} → {result["final_test"]["reconstructed"]["mean_iou"]:.3f}</b><small>選択にも使わなかった12視点の平均</small></div><div class="card"><small>改善幅</small><b>+{result["test_improvement_pp"]:.1f} pt</b><small>百分率ポイント</small></div><div class="card"><small>復元 / 選択 / 最終テスト</small><b>12 / 12 / 12</b><small>3つの画像集合を完全に分離</small></div><div class="card"><small>採用した格子間隔</small><b>{result["voxel_size_mm"]:.1f} mm</b><small>物理的な誤差保証ではありません</small></div></div>
<section><h2>手描きの形状から、複数画像による形状へ</h2><div class="pair"><figure><img src="{before}" alt="前回コードの再生成モデル"><figcaption>改善前：gpt-6.2-astraが生成したコードを再実行。</figcaption></figure><figure><img src="{after}" alt="多視点輪郭による復元モデル"><figcaption>改善後：12方向の輪郭で復元した実メッシュに、写真の色を投影・融合。</figcaption></figure></div></section>
<div class="body"><div><section><h2>立体を回して確認</h2><canvas id="viewer" aria-label="ドラッグで回転できる復元メッシュ" role="img"></canvas><p><button id="reset">視点を戻す</button> ドラッグで回転、ホイールで拡大。表示用に格子を粗くしたメッシュです。</p><p>高解像度の <code>reconstructed.blend</code> / <code>reconstructed.glb</code> / <code>reconstructed.stl</code> は実行先フォルダに保存。大容量データはGitに含めません。</p></section>
<section><h2>復元・選択に使わなかった12方向で照合</h2><img src="{overlay}" alt="検証視点の輪郭の重ね合わせ"><p>緑：一致　橙：不足　紫：はみ出し。カメラの枠合わせは復元用の12視点だけから推定し、他視点は補間。最終テストは格子選択後に一度だけ評価します。</p></section>
<section><h2>輪郭ベースの候補記録（最終採用ではない）</h2><table><thead><tr><th>長手方向の格子数</th><th>格子間隔</th><th>選択用IoU</th><th>判定</th></tr></thead><tbody>{rounds}</tbody></table><p>開始時より0.01以上改善し、現在の採用案より0.001以上改善した場合のみ更新。予算上限で停止します。</p></section></div>
<aside><section><h2>今回の到達点</h2><p class="note"><b>輪郭の改善を実測しました。寸法拘束の成立は、実車精度の証明ではありません。</b></p><p>補助の輪郭ゲート：<b>{"通過" if result["assessment"]["visual_gate"] else "未達"}</b><br>寸法拘束ゲート：<b>{"通過" if result["assessment"]["dimension_gate"] else "未達"}</b><br>旧簡易描画の診断値：<b>{result["appearance"]["mean_psnr_db"]:.1f} dB / {"通過" if result["assessment"]["appearance_gate"] else "未達"}</b><br>実車精度の認証：<b>未達</b></p><h3>精密化に残る条件</h3><ul><li>実際のカメラ内部・外部パラメータ</li><li>独立した実測値またはOEM CAD</li><li>凹面・下面・内部機構と公差</li></ul><p>写真の照明はテクスチャに含まれます。高い輪郭スコアは色・面精度・内部構造の正解を意味しません。</p></section>
<section><h2>根拠と仕様</h2><p>{html.escape(config["profile"])}</p><p>4365 × 1800 × 1610 mm。全幅はミラーを除く車体の値です。</p><p><a href="{html.escape(config["specification"]["url"])}">日産公式主要諸元 PDF・2ページ</a><br><a href="https://www3.nissan.co.jp/vehicles/new/kicks/exterior.html">日産公式360°ビュー</a></p><p>元の小画像と同じグレードかは未確認です。寸法は人が資料と照合した設定値。runtimeは根拠URL・取得物のSHA-256を記録します。</p></section>
<section><h2>実行ログ</h2><ul class="events">{timeline}</ul></section></aside></div><footer>自律実行結果の保存版。画像は参照・比較用の縮小表示。外部ライブラリやネットワークなしで開けます。</footer></main>
<script id="mesh" type="application/json">{payload}</script><script>
const data=JSON.parse(document.getElementById('mesh').textContent),canvas=document.getElementById('viewer'),gl=canvas.getContext('webgl');
if(gl&&data.vertices){{
const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const shader=(kind,src)=>{{const s=gl.createShader(kind);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}};
const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec3 p;attribute vec3 color;uniform vec2 angle;uniform vec2 scale;varying vec3 c;void main(){{vec3 v=p*0.0001-vec3(0.,0.,0.8);float a=angle.x,b=angle.y;vec3 q=vec3(cos(a)*v.x-sin(a)*v.y,sin(a)*v.x+cos(a)*v.y,v.z);vec3 r=vec3(q.x,cos(b)*q.z-sin(b)*q.y,cos(b)*q.y+sin(b)*q.z);gl_Position=vec4(r.x*scale.x,r.y*scale.y,-r.z/10.,1.);c=color;}}'));
gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 c;void main(){{gl_FragColor=vec4(c,1.);}}'));gl.linkProgram(program);gl.useProgram(program);
for(const [name,array,type,normalized] of [['p',new Int16Array(decode(data.vertices).buffer),gl.SHORT,false],['color',decode(data.colors),gl.UNSIGNED_BYTE,true]]){{const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,array,gl.STATIC_DRAW);const attr=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(attr);gl.vertexAttribPointer(attr,3,type,normalized,0,0);}}
let yaw=.8,pitch=.25,zoom=1,drag=null;gl.enable(gl.DEPTH_TEST);const angle=gl.getUniformLocation(program,'angle'),scale=gl.getUniformLocation(program,'scale');
function draw(){{canvas.width=Math.round(canvas.clientWidth*devicePixelRatio);canvas.height=Math.round(canvas.clientHeight*devicePixelRatio);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.91,.94,.96,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.uniform2f(angle,yaw,pitch);gl.uniform2f(scale,1/(3*zoom),canvas.width/canvas.height/(3*zoom));gl.drawArrays(gl.TRIANGLES,0,data.count);}}
canvas.onpointerdown=e=>{{drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId)}};canvas.onpointerup=()=>drag=null;canvas.onpointermove=e=>{{if(!drag)return;yaw+=(e.clientX-drag[0])*.008;pitch=Math.max(-1.2,Math.min(1.2,pitch+(e.clientY-drag[1])*.008));drag=[e.clientX,e.clientY];draw()}};canvas.addEventListener('wheel',e=>{{e.preventDefault();zoom=Math.max(.5,Math.min(2,zoom*Math.exp(e.deltaY*.001)));draw()}},{{passive:false}});document.getElementById('reset').onclick=()=>{{yaw=.8;pitch=.25;zoom=1;draw()}};window.addEventListener('resize',draw);draw();
}}else{{canvas.replaceWith(document.createTextNode('3Dプレビューを表示できません。上のレンダリング画像を参照してください。'));}}
</script></html>'''
    (out / "report.html").write_text(document)
