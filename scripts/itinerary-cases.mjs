// Inputs only: the model receives URLs and the request, never a completed itinerary.
export const itineraryCases = {
  ueno: {
    id: "ueno",
    label: "上野",
    output: "autonomous-cafe-day",
    snapshot: "visual-autonomous-cafe-answer",
    receipt: "autonomous-itinerary-e2e",
    query:
      "2026年11月21日（土）に大人2人で上野を10:00〜15:00、一日遊ぶカフェ旅行を正式な実行プランにしてください。現地の入園・飲食は2人合計10000円以内で交通費は除きます。主案は上野動物園とEVERYONEs CAFE。カフェでは80分ほど過ごし、各自1皿の甘味と1杯の飲物を注文して軽い昼食にします。共有や未確認のセット割に依存せず、定番の掲載商品価格から予算を作ってください。営業時間、対象日の開園予定、主案の価格、カフェの利用方式、候補比較、休憩所の名称・所在地・時間を公式資料で確認し、写真付きの体験と地図をHTMLで見られる回答にしてください。休憩20分、徒歩移動、入店待ちも独立した手順にし、時間の重複と10分を超える空白を作らないでください。満席で20分待っても入れない場合はスターバックス上野恩賜公園店へ切り替える手順を含めてください。代替店の商品単価が未掲載なら店頭で確認して2人3000円以内で注文する条件付き代替案にし、主案の掲載価格とは分けて比較してください。未来の空席や予約完了は断定せず、公式の利用方式を確認した上で席だけを当日判断とします。税区分が書かれていない資料は掲載額と税区分未記載を明示してください。写真は実画像を確認し、注文品の写真がなければ同じ店舗の外観や店内を使えます。SNS調査は不要です。",
    urls: [
      "https://www.tokyo-zoo.net/ueno/visitor-info/tickets/",
      "https://www.tokyo-zoo.net/ueno/shops/foodshop/index.html",
      "https://www.tokyo-zoo.net/file/calendar_2026_ueno.pdf",
      "https://shop.create-restaurants.co.jp/0941/",
      "https://store.starbucks.co.jp/detail-1087/",
      "https://nominatim.openstreetmap.org/",
    ],
  },
  hamamatsu: {
    id: "hamamatsu",
    label: "静岡県浜松市",
    output: "hamamatsu-day",
    snapshot: "visual-hamamatsu-answer",
    receipt: "hamamatsu-itinerary-e2e",
    query:
      "2026年11月21日（土）に大人2人で静岡県浜松市を10:00〜15:00、一日遊ぶカフェ旅行を正式な実行プランにしてください。JR浜松駅北口から始めて同じエリアで終え、徒歩中心です。現地の入館・飲食は2人合計10000円以内で交通費は除きます。主案は浜松市楽器博物館とオークラアクトシティホテル浜松のザ・シーズンカフェ。カフェでは昼食と飲物と甘味を楽しむ80分程度を確保し、各自1皿の食事・飲物1杯・甘味1品を選んでください。セットで飲物が含まれるなら重複加算せず、公式に条件が明記された掲載額を使います。営業時間、対象日の開館予定、主案の商品価格と税・サービス料、利用方式、候補比較、休憩所の具体的な場所と利用時間を公式で確認してください。休憩20分、徒歩移動、入店待ちも独立した手順にして、時刻重複と10分を超える空白を残さない。満席20分で未入店ならスターバックス浜松メイワン2階店へ切り替える具体手順を示し、代替店の単価が未掲載なら店頭で2人3000円以内を確認して注文する条件付き代替とし、主案の掲載価格と分けます。季節品・営業時間の古い記事・別店舗・テイクアウト価格を混同しない。現在公開されている公式情報に基づいて調査する。写真は実画像を確認し、同じ施設の外観・店内も使えます。地図と写真付き体験、移動・休憩の過ごし方をHTMLで見られる構造化回答にしてください。未来の空席・当日提供・予約完了を断定せず、席は当日判断。予約・購入・問い合わせは実行しません。SNS調査は不要です。",
    urls: [
      "https://www.gakkihaku.jp/guide/",
      "https://www.gakkihaku.jp/",
      "https://www.act-okura.co.jp/restaurant/cafe/",
      "https://www.act-okura.co.jp/restaurant-plan/cafemenu202303/",
      "https://www.actcity.jp/visitor/act/",
      "https://www.actcity.jp/faq/",
      "https://store.starbucks.co.jp/detail-4544/",
      "https://nominatim.openstreetmap.org/",
    ],
  },
  nagoya: {
    id: "nagoya",
    label: "愛知県名古屋市",
    output: "nagoya-day",
    snapshot: "visual-nagoya-answer",
    receipt: "nagoya-itinerary-e2e",
    query:
      "2026年11月21日（土）に大人2人で愛知県名古屋市を10:00〜15:00、一日遊ぶカフェ旅行を正式な実行プランにしてください。地下鉄伏見駅から始めて同じエリアで終え、徒歩中心です。現地の入館・飲食は2人合計10000円以内で交通費は除きます。主案はFUJIなごや科学館（名古屋市科学館）の展示室のみ。プラネタリウムや有料特別展は主案に含めないとFUJIなごや科学館カフェレストラン。カフェでは昼食と飲物と甘味を楽しむ80分程度を確保し、各自1皿の食事・飲物1杯・甘味1品を選んでください。セットで飲物が含まれるなら重複加算せず、公式に条件が明記された掲載額を使います。営業時間、対象日の開館予定、主案の商品価格と税・サービス料、利用方式、候補比較、休憩所の具体的な場所と利用時間を公式で確認してください。休憩20分、徒歩移動、入店待ちも独立した手順にして、時刻重複と10分を超える空白を残さない。満席20分で未入店ならスターバックス名古屋伏見ATビル店へ切り替える具体手順を示し、代替店の単価が未掲載なら店頭で2人3000円以内を確認して注文する条件付き代替とし、主案の掲載価格と分けます。季節品・営業時間の古い記事・別店舗・テイクアウト価格を混同しない。現在公開されている公式情報に基づいて調査する。写真は実画像を確認し、同じ施設の外観・店内も使えます。地図と写真付き体験、移動・休憩の過ごし方をHTMLで見られる構造化回答にしてください。未来の空席・当日提供・予約完了を断定せず、席は当日判断。予約・購入・問い合わせは実行しません。SNS調査は不要です。",
    urls: [
      "https://www.ncsm.city.nagoya.jp/visit/visitors_guide/admission.html",
      "https://www.ncsm.city.nagoya.jp/visit/visitors_guide/facilities.html",
      "https://www.ncsm.city.nagoya.jp/",
      "https://www.nomura-medias.co.jp/shop_list/1083/",
      "https://www.nomura-medias.co.jp/works/228/",
      "https://www.nomura-medias.co.jp/news/774/",
      "https://store.starbucks.co.jp/detail-533/",
      "https://nominatim.openstreetmap.org/",
    ],
  },
};

// Intent regression cases: no clock range is supplied, so the runtime must infer the requested scope.
itineraryCases["hamamatsu-full"] = {
  id: "hamamatsu-full",
  label: "浜松・朝から夜まで",
  output: "hamamatsu-full-day",
  snapshot: "visual-hamamatsu-full-answer",
  receipt: "hamamatsu-full-itinerary-e2e",
  budgetCap: 20000,
  query:
    "2026年11月21日（土）大人2人で浜松を朝から夜まで丸一日、ゆっくり楽しむ旅行プランを作ってください。JR浜松駅を出発・帰着にし、午前の体験、昼食、午後の体験とカフェ、休憩、夕食、夜の帰路までトータルコーディネートしてください。楽器博物館、ザ・シーズンカフェ、展望回廊、むつぎくを候補にし、公式の開館・提供枠に合わなければ時間配分や採否を変えてください。現地の入館・飲食は2人合計20000円以内、交通費は別。具体的な掲載商品・食事の単価で合算し、飲物込みのセットを重複加算しないでください。満席待ち20分を上限に、雨・疲労時の切替と休憩場所も示してください。写真と地図を載せ、時間帯ごとに行きたくなる見どころと小さな楽しみ方を提案してください。各手順にkindとvenueUrlを付け、stepChecksの営業時間・締切の引用を検査し、不足はverify_stepsの追加調査で確認してから最終化。現地の空席や未来の営業は確約せず、通常の公開予定と対象日未確認を区別してください。予約・購入・問い合わせは実行しません。SNS調査は不要です。",
  urls: [
    ...itineraryCases.hamamatsu.urls.filter((u) => !u.includes("starbucks")),
    "https://www.act-okura.co.jp/facilities/gallery/",
    "https://www.mutsugiku.jp/",
  ],
};
itineraryCases["nagoya-afternoon"] = {
  id: "nagoya-afternoon",
  label: "名古屋・午後だけ",
  minimumCandidates: 2,
  output: "nagoya-afternoon",
  snapshot: "visual-nagoya-afternoon-answer",
  receipt: "nagoya-afternoon-itinerary-e2e",
  budgetCap: 10000,
  query:
    "2026年11月21日（土）大人2人で名古屋の伏見あたりを、午後だけちょっとゆっくり遊ぶプランを作ってください。伏見駅発着、FUJIなごや科学館の展示室のみと同館カフェレストランを中心に、写真と地図を見て行きたくなるものに。プラネタリウムや有料特別展は含めません。カフェで各自甘味1品と飲物1杯を楽しみ、疲れない休憩も確保。半日なので夕食や夜の観光は加えず、体験を詰め込みすぎないでください。2人合計10000円以内、交通費は別。公式の具体的な掲載商品価格で合算。移動、満席待ち上限20分、雨・疲労の切替も具体化してください。各手順にkindとvenueUrlを付け、stepChecksの営業時間・締切・価格の引用を検査。不足はverify_stepsの追加調査で確認してから最終化。公開予定と対象日未確認を区別し、空席や未来の営業は確約しません。予約・購入・問い合わせは実行しません。SNS調査は不要です。",
  urls: itineraryCases.nagoya.urls,
};

itineraryCases["hamamatsu-state"] = {
  id: "hamamatsu-state",
  label: "浜松・距離と滞在を考える一日",
  output: "hamamatsu-experience-state",
  snapshot: "visual-hamamatsu-state-answer",
  receipt: "hamamatsu-state-itinerary-e2e",
  budgetCap: 20000,
  query:
    "2026年11月21日（土）大人2人、浜松駅発着で09:00〜20:00の一日をゆっくり遊ぶ計画を作ってください。午前と午後の具体的な体験、昼食、カフェ、正味15分以上の休憩、夕食、帰路まで含めます。楽器博物館、展望回廊、ザ・シーズンカフェ＆ラウンジ、アクトの森が候補です。公式資料を比較して採否を決め、営業時間に合わない・取得できない候補は不採用の理由を明記して別の確認できた候補へ切り替えられます。現地入館飲食は2人合計20000円以内、交通費別。資料の明確な定番商品単価から計算し、セットを重複加算しません。写真と地図付きHTMLで見たいです。移動距離と滞在時間のstateを保存し、read_journey_stateで距離・方向・ペース・正味滞在・疲労と休憩を検査してから最終化してください。館内の上下移動にも時間を取り、移動本体・待ち・乗降・余裕を区別。徒歩の各端点はlocate_placeで引用座標を取得、同一建物の別階は同じ代表点を使ってfloorを分けられます。少ない地点であっても観察・会話・休憩の中身を具体化し、時間埋めの待機や長すぎる滞在で11時間を装わない。新しい実績を創作せず、過去の生成案は実際の移動・滞在と区別。全ての移動と正味滞在をjourneyStateへ結び付け、stepChecksで営業時間を照合。未来の空席・営業は確約しません。予約・購入・問い合わせ・SNS調査は行いません。",
  urls: [
    ...itineraryCases["hamamatsu-full"].urls.filter(
      (u) => !u.includes("mutsugiku"),
    ),
    "https://www.act-okura.co.jp/restaurant/lounge/",
    "https://www.act-okura.co.jp/restaurant-plan/cafe_cocktailtime/",
  ],
};

itineraryCases["hamamatsu-state-city"] = {
  ...itineraryCases["hamamatsu-state"],
  id: "hamamatsu-state-city",
  output: "hamamatsu-experience-state",
  snapshot: "visual-hamamatsu-state-city-answer",
  receipt: "hamamatsu-state-city-itinerary-e2e",
  query:
    itineraryCases["hamamatsu-state"].query +
    " 市街地の別候補として浜松城も比較してください。市や観光協会の案内は運営者の当日情報と区別し、採用するかは営業時間・移動距離・残り時間から判断します。公園へ出る区間をindoorに置き換えず、徒歩の座標や経路時間が取れなければ未確認にして不採用にもできます。",
  urls: [
    ...itineraryCases["hamamatsu-state"].urls,
    "https://www.city.hamamatsu.shizuoka.jp/maps/c-castle.html",
    "https://www.city.hamamatsu.shizuoka.jp/documents/172795/1003.pdf",
    "https://hamamatsu-daisuki.net/pickup/7915/",
  ],
};

itineraryCases["hamamatsu-state-improved"] = {
  ...itineraryCases["hamamatsu-state-city"],
  id: "hamamatsu-state-improved",
  snapshot: "visual-hamamatsu-state-improved-answer",
  receipt: "hamamatsu-state-improved-e2e",
};
