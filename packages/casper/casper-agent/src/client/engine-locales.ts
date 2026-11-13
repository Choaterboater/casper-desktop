/** `casper-engine` namespace dictionaries for the Casper engine row in General Settings. */

/** Dictionary namespace owned by the Casper engine row. */
export const ENGINE_NS = 'casper-engine'

/** English dictionary (the key-set source of truth). */
export const engineEn = {
  'engine.checking': 'Casper engine: checking',
  'engine.bundled': 'Casper engine: {version}, shipped with the app',
  'engine.installed': 'Casper engine: {version}, installed on this computer',
  'engine.missingBundled': 'Casper engine: missing from the app. Reinstall the app.',
  'engine.missingInstalled': 'Casper engine: not found on this computer',
  'engine.unknown': 'Casper engine: version not known',
} satisfies Record<string, string>

/** The engine row's namespace key union. */
export type CasperEngineKey = keyof typeof engineEn

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Casper engine row in General Settings. */
    'casper-engine': CasperEngineKey
  }
}

/** Simplified Chinese dictionary. */
export const engineZh = {
  'engine.checking': 'Casper 引擎：正在检查',
  'engine.bundled': 'Casper 引擎：{version}，随应用提供',
  'engine.installed': 'Casper 引擎：{version}，安装在这台电脑上',
  'engine.missingBundled': 'Casper 引擎：应用中缺少引擎。请重新安装应用。',
  'engine.missingInstalled': 'Casper 引擎：在这台电脑上未找到',
  'engine.unknown': 'Casper 引擎：版本未知',
} satisfies Record<CasperEngineKey, string>

/** Japanese dictionary. */
export const engineJa = {
  'engine.checking': 'Casper エンジン：確認中',
  'engine.bundled': 'Casper エンジン：{version}、アプリに同梱',
  'engine.installed': 'Casper エンジン：{version}、このコンピューターにインストール済み',
  'engine.missingBundled': 'Casper エンジン：アプリにありません。アプリを再インストールしてください。',
  'engine.missingInstalled': 'Casper エンジン：このコンピューターに見つかりません',
  'engine.unknown': 'Casper エンジン：バージョン不明',
} satisfies Record<CasperEngineKey, string>

/** Spanish dictionary. */
export const engineEs = {
  'engine.checking': 'Motor de Casper: comprobando',
  'engine.bundled': 'Motor de Casper: {version}, incluido con la app',
  'engine.installed': 'Motor de Casper: {version}, instalado en este equipo',
  'engine.missingBundled': 'Motor de Casper: falta en la app. Reinstala la app.',
  'engine.missingInstalled': 'Motor de Casper: no se encontró en este equipo',
  'engine.unknown': 'Motor de Casper: versión desconocida',
} satisfies Record<CasperEngineKey, string>

/** French dictionary. */
export const engineFr = {
  'engine.checking': 'Moteur Casper : vérification',
  'engine.bundled': "Moteur Casper : {version}, fourni avec l'app",
  'engine.installed': 'Moteur Casper : {version}, installé sur cet ordinateur',
  'engine.missingBundled': "Moteur Casper : absent de l'app. Réinstallez l'app.",
  'engine.missingInstalled': 'Moteur Casper : introuvable sur cet ordinateur',
  'engine.unknown': 'Moteur Casper : version inconnue',
} satisfies Record<CasperEngineKey, string>

/** German dictionary. */
export const engineDe = {
  'engine.checking': 'Casper-Engine: wird geprüft',
  'engine.bundled': 'Casper-Engine: {version}, mit der App geliefert',
  'engine.installed': 'Casper-Engine: {version}, auf diesem Computer installiert',
  'engine.missingBundled': 'Casper-Engine: fehlt in der App. Installieren Sie die App neu.',
  'engine.missingInstalled': 'Casper-Engine: auf diesem Computer nicht gefunden',
  'engine.unknown': 'Casper-Engine: Version unbekannt',
} satisfies Record<CasperEngineKey, string>

/** Russian dictionary. */
export const engineRu = {
  'engine.checking': 'Движок Casper: проверка',
  'engine.bundled': 'Движок Casper: {version}, входит в приложение',
  'engine.installed': 'Движок Casper: {version}, установлен на этом компьютере',
  'engine.missingBundled': 'Движок Casper: отсутствует в приложении. Переустановите приложение.',
  'engine.missingInstalled': 'Движок Casper: не найден на этом компьютере',
  'engine.unknown': 'Движок Casper: версия неизвестна',
} satisfies Record<CasperEngineKey, string>

/** Portuguese dictionary. */
export const enginePt = {
  'engine.checking': 'Motor do Casper: verificando',
  'engine.bundled': 'Motor do Casper: {version}, incluído no app',
  'engine.installed': 'Motor do Casper: {version}, instalado neste computador',
  'engine.missingBundled': 'Motor do Casper: ausente no app. Reinstale o app.',
  'engine.missingInstalled': 'Motor do Casper: não encontrado neste computador',
  'engine.unknown': 'Motor do Casper: versão desconhecida',
} satisfies Record<CasperEngineKey, string>
