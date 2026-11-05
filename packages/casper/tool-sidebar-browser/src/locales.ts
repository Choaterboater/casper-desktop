/** Locale-owned text of the per-site permission question. */

/** English site-permission messages. */
export const en = {
  question: 'Allow Casper to click and type on this site?',
  detail: 'Casper can then click, type, press keys, and scroll on pages from this site in this conversation\'s browser tabs. Reading pages and taking screenshots never ask.',
  approve: 'Allow',
}

/** Chinese site-permission messages. */
export const zh = {
  question: '允许 Casper 在此网站上点击和输入吗？',
  detail: '允许后，Casper 可以在本对话的浏览器标签页中对此网站的页面进行点击、输入、按键和滚动。读取页面和截图不会询问。',
  approve: '允许',
} satisfies Record<keyof typeof en, string>

/** Japanese site-permission messages. */
export const ja = {
  question: 'Casper にこのサイトでのクリックと入力を許可しますか？',
  detail: '許可すると、Casper はこの会話のブラウザタブで、このサイトのページをクリック、入力、キー操作、スクロールできます。ページの読み取りとスクリーンショットでは確認しません。',
  approve: '許可',
} satisfies Record<keyof typeof en, string>

/** Spanish site-permission messages. */
export const es = {
  question: '¿Permitir que Casper haga clic y escriba en este sitio?',
  detail: 'Casper podrá hacer clic, escribir, pulsar teclas y desplazarse en las páginas de este sitio en las pestañas del navegador de esta conversación. Leer páginas y hacer capturas de pantalla nunca lo pide.',
  approve: 'Permitir',
} satisfies Record<keyof typeof en, string>

/** French site-permission messages. */
export const fr = {
  question: 'Autoriser Casper à cliquer et à saisir du texte sur ce site ?',
  detail: 'Casper pourra alors cliquer, saisir du texte, appuyer sur des touches et faire défiler les pages de ce site dans les onglets du navigateur de cette conversation. La lecture des pages et les captures d’écran ne le demandent jamais.',
  approve: 'Autoriser',
} satisfies Record<keyof typeof en, string>

/** German site-permission messages. */
export const de = {
  question: 'Darf Casper auf dieser Website klicken und tippen?',
  detail: 'Casper kann dann auf Seiten dieser Website in den Browser-Tabs dieser Unterhaltung klicken, tippen, Tasten drücken und scrollen. Für das Lesen von Seiten und Screenshots wird nie gefragt.',
  approve: 'Zulassen',
} satisfies Record<keyof typeof en, string>

/** Russian site-permission messages. */
export const ru = {
  question: 'Разрешить Casper нажимать и вводить текст на этом сайте?',
  detail: 'После этого Casper сможет нажимать, вводить текст, нажимать клавиши и прокручивать страницы этого сайта во вкладках браузера этого разговора. Для чтения страниц и снимков экрана разрешение не запрашивается.',
  approve: 'Разрешить',
} satisfies Record<keyof typeof en, string>

/** Portuguese site-permission messages. */
export const pt = {
  question: 'Permitir que o Casper clique e digite neste site?',
  detail: 'O Casper poderá clicar, digitar, pressionar teclas e rolar nas páginas deste site nas abas do navegador desta conversa. Ler páginas e fazer capturas de tela nunca pedem permissão.',
  approve: 'Permitir',
} satisfies Record<keyof typeof en, string>

/** Display translations resolved by the Client; the answer labels on the wire stay English. */
export const siteAccessDisplay = {
  question: {
    en: en.question, zh: zh.question, ja: ja.question, es: es.question, fr: fr.question, de: de.question, ru: ru.question, pt: pt.question,
  },
  detail: { en: en.detail, zh: zh.detail, ja: ja.detail, es: es.detail, fr: fr.detail, de: de.detail, ru: ru.detail, pt: pt.detail },
  approve: {
    en: en.approve, zh: zh.approve, ja: ja.approve, es: es.approve, fr: fr.approve, de: de.approve, ru: ru.approve, pt: pt.approve,
  },
}
