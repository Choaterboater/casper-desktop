/** `casper-receipt` namespace dictionaries for Casper's receipt card. */

/** Dictionary namespace owned by the receipt card. */
export const NS = 'casper-receipt'

/** English dictionary (the key-set source of truth). */
export const en = {
  'row.title': 'Receipt',
  'row.running': 'Writing the receipt',
  'row.changed': 'Changed files',
  'row.notCompared': 'Casper could not compare the workspace',
  'row.noChanges': 'No files changed',
  'row.checksRun': 'Checks run',
  'row.checksNotRun': 'Checks not run',
  'row.noChecks': 'No checks ran',
  'row.pass': 'passed',
  'row.fail': 'failed',
  'row.usage': 'Model use',
  'row.tokens': '{count} tokens',
  'row.tokensUnknown': 'Tokens not known',
  'row.charged': 'Charged {amount}',
  'row.estimate': 'About {amount} (estimate)',
  'row.subscription': 'Paid by your subscription',
  'row.costUnknown': 'Cost not known',
  'row.open': 'Open {path}',
  'row.inspect': 'Inspect call',
} satisfies Record<string, string>

/** The receipt namespace key union. */
export type CasperReceiptKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Casper's receipt card copy. */
    'casper-receipt': CasperReceiptKey
  }
}

/** Simplified Chinese dictionary. */
export const zh = {
  'row.title': '回执',
  'row.running': '正在生成回执',
  'row.changed': '已更改的文件',
  'row.notCompared': 'Casper 无法比较工作区',
  'row.noChanges': '没有文件更改',
  'row.checksRun': '已运行的检查',
  'row.checksNotRun': '未运行的检查',
  'row.noChecks': '没有运行检查',
  'row.pass': '通过',
  'row.fail': '失败',
  'row.usage': '模型用量',
  'row.tokens': '{count} 个 token',
  'row.tokensUnknown': 'token 数未知',
  'row.charged': '已扣费 {amount}',
  'row.estimate': '约 {amount}（估算）',
  'row.subscription': '由你的订阅支付',
  'row.costUnknown': '费用未知',
  'row.open': '打开 {path}',
  'row.inspect': '查看调用',
} satisfies Record<CasperReceiptKey, string>

/** Japanese dictionary. */
export const ja = {
  'row.title': 'レシート',
  'row.running': 'レシートを作成中',
  'row.changed': '変更されたファイル',
  'row.notCompared': 'Casper はワークスペースを比較できませんでした',
  'row.noChanges': '変更されたファイルはありません',
  'row.checksRun': '実行したチェック',
  'row.checksNotRun': '実行しなかったチェック',
  'row.noChecks': 'チェックは実行されませんでした',
  'row.pass': '成功',
  'row.fail': '失敗',
  'row.usage': 'モデルの使用量',
  'row.tokens': '{count} トークン',
  'row.tokensUnknown': 'トークン数は不明です',
  'row.charged': '{amount} を請求済み',
  'row.estimate': '約 {amount}（見積もり）',
  'row.subscription': 'サブスクリプションで支払い',
  'row.costUnknown': '費用は不明です',
  'row.open': '{path} を開く',
  'row.inspect': '呼び出しを確認',
} satisfies Record<CasperReceiptKey, string>

/** Spanish dictionary. */
export const es = {
  'row.title': 'Recibo',
  'row.running': 'Escribiendo el recibo',
  'row.changed': 'Archivos modificados',
  'row.notCompared': 'Casper no pudo comparar el espacio de trabajo',
  'row.noChanges': 'No cambió ningún archivo',
  'row.checksRun': 'Comprobaciones ejecutadas',
  'row.checksNotRun': 'Comprobaciones no ejecutadas',
  'row.noChecks': 'No se ejecutó ninguna comprobación',
  'row.pass': 'correcta',
  'row.fail': 'fallida',
  'row.usage': 'Uso del modelo',
  'row.tokens': '{count} tokens',
  'row.tokensUnknown': 'Tokens desconocidos',
  'row.charged': 'Cobrado {amount}',
  'row.estimate': 'Unos {amount} (estimación)',
  'row.subscription': 'Pagado por tu suscripción',
  'row.costUnknown': 'Coste desconocido',
  'row.open': 'Abrir {path}',
  'row.inspect': 'Inspeccionar llamada',
} satisfies Record<CasperReceiptKey, string>

/** French dictionary. */
export const fr = {
  'row.title': 'Reçu',
  'row.running': 'Rédaction du reçu',
  'row.changed': 'Fichiers modifiés',
  'row.notCompared': 'Casper n’a pas pu comparer l’espace de travail',
  'row.noChanges': 'Aucun fichier modifié',
  'row.checksRun': 'Vérifications exécutées',
  'row.checksNotRun': 'Vérifications non exécutées',
  'row.noChecks': 'Aucune vérification exécutée',
  'row.pass': 'réussie',
  'row.fail': 'échouée',
  'row.usage': 'Utilisation du modèle',
  'row.tokens': '{count} jetons',
  'row.tokensUnknown': 'Jetons inconnus',
  'row.charged': 'Facturé {amount}',
  'row.estimate': 'Environ {amount} (estimation)',
  'row.subscription': 'Payé par votre abonnement',
  'row.costUnknown': 'Coût inconnu',
  'row.open': 'Ouvrir {path}',
  'row.inspect': 'Inspecter l’appel',
} satisfies Record<CasperReceiptKey, string>

/** German dictionary. */
export const de = {
  'row.title': 'Beleg',
  'row.running': 'Beleg wird erstellt',
  'row.changed': 'Geänderte Dateien',
  'row.notCompared': 'Casper konnte den Arbeitsbereich nicht vergleichen',
  'row.noChanges': 'Keine Dateien geändert',
  'row.checksRun': 'Ausgeführte Prüfungen',
  'row.checksNotRun': 'Nicht ausgeführte Prüfungen',
  'row.noChecks': 'Keine Prüfungen ausgeführt',
  'row.pass': 'bestanden',
  'row.fail': 'fehlgeschlagen',
  'row.usage': 'Modellnutzung',
  'row.tokens': '{count} Tokens',
  'row.tokensUnknown': 'Tokens unbekannt',
  'row.charged': '{amount} berechnet',
  'row.estimate': 'Etwa {amount} (Schätzung)',
  'row.subscription': 'Über dein Abo bezahlt',
  'row.costUnknown': 'Kosten unbekannt',
  'row.open': '{path} öffnen',
  'row.inspect': 'Aufruf prüfen',
} satisfies Record<CasperReceiptKey, string>

/** Russian dictionary. */
export const ru = {
  'row.title': 'Отчёт',
  'row.running': 'Составляется отчёт',
  'row.changed': 'Изменённые файлы',
  'row.notCompared': 'Casper не смог сравнить рабочую область',
  'row.noChanges': 'Файлы не изменены',
  'row.checksRun': 'Выполненные проверки',
  'row.checksNotRun': 'Невыполненные проверки',
  'row.noChecks': 'Проверки не выполнялись',
  'row.pass': 'пройдена',
  'row.fail': 'не пройдена',
  'row.usage': 'Использование модели',
  'row.tokens': 'Токенов: {count}',
  'row.tokensUnknown': 'Число токенов неизвестно',
  'row.charged': 'Списано {amount}',
  'row.estimate': 'Около {amount} (оценка)',
  'row.subscription': 'Оплачено подпиской',
  'row.costUnknown': 'Стоимость неизвестна',
  'row.open': 'Открыть {path}',
  'row.inspect': 'Просмотреть вызов',
} satisfies Record<CasperReceiptKey, string>

/** Portuguese dictionary. */
export const pt = {
  'row.title': 'Recibo',
  'row.running': 'Escrevendo o recibo',
  'row.changed': 'Arquivos alterados',
  'row.notCompared': 'O Casper não conseguiu comparar o espaço de trabalho',
  'row.noChanges': 'Nenhum arquivo alterado',
  'row.checksRun': 'Verificações executadas',
  'row.checksNotRun': 'Verificações não executadas',
  'row.noChecks': 'Nenhuma verificação executada',
  'row.pass': 'aprovada',
  'row.fail': 'falhou',
  'row.usage': 'Uso do modelo',
  'row.tokens': '{count} tokens',
  'row.tokensUnknown': 'Tokens desconhecidos',
  'row.charged': 'Cobrado {amount}',
  'row.estimate': 'Cerca de {amount} (estimativa)',
  'row.subscription': 'Pago pela sua assinatura',
  'row.costUnknown': 'Custo desconhecido',
  'row.open': 'Abrir {path}',
  'row.inspect': 'Inspecionar chamada',
} satisfies Record<CasperReceiptKey, string>
