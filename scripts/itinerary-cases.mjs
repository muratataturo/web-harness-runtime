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
