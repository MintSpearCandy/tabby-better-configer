import { Injectable } from '@angular/core'
import { LocaleService } from 'tabby-core'

/** Translations for the BetterConfiger settings tab. Keys are prefixed with
 *  `betterConfiger.` to avoid clashes with host/other-plugin translations.
 *
 *  NOTE on the approach: @ngx-translate/core is NOT require-able from a user
 *  plugin's module context (only builtin plugins resolve it, via the app.asar
 *  node_modules) — importing it makes the whole plugin — and every user
 *  plugin loaded after it — silently fail to load. So we take the locale from
 *  tabby-core's exported LocaleService and do our own table lookup. */
const TRANSLATIONS: Record<string, Record<string, string>> = {
    en: {
        'betterConfiger.title': 'Config Manager',
        'betterConfiger.description': 'View, edit, import and export each section of config.yaml',
        'betterConfiger.toolbar.import': 'Import package…',
        'betterConfiger.toolbar.exportAll': 'Export all…',
        'betterConfiger.hint.select': 'Select a config section on the left',
        'betterConfiger.nav.other': 'Other (no provider)',
        'betterConfiger.nav.shared': 'shared',
        'betterConfiger.nav.sensitive': 'sensitive',
        'betterConfiger.editor.current': 'Current (config.yaml)',
        'betterConfiger.editor.defaults': 'Defaults (read-only)',
        'betterConfiger.editor.notSet': 'Not set in config.yaml — defaults apply. Type YAML below to override.',
        'betterConfiger.editor.valid': 'Valid YAML',
        'betterConfiger.editor.invalid': 'Invalid YAML',
        'betterConfiger.editor.save': 'Save and apply',
        'betterConfiger.editor.discard': 'Discard changes',
        'betterConfiger.editor.export': 'Export',
        'betterConfiger.editor.cancel': 'Cancel',
        'betterConfiger.editor.saved': 'Section saved',
        'betterConfiger.warn.restart': 'Some settings in this section only take effect after a restart.',
        'betterConfiger.warn.profiles': 'Profiles are structural data (IDs are referenced by groups and hotkeys). Hand-editing may break references — a dedicated form is planned.',
        'betterConfiger.warn.sensitive': 'This section is sensitive (secrets/encryption/sync credentials). Editing or importing it can lock you out or point sync at another account.',
        'betterConfiger.warn.orphan': 'No installed plugin declares this section — probably left over from an uninstalled plugin.',
        'betterConfiger.import.notAPackage': 'The selected file is not a BetterConfiger config package',
        'betterConfiger.import.badJson': 'Could not parse the selected file as JSON',
        'betterConfiger.import.failed': 'Import failed',
        'betterConfiger.import.applied': 'Package applied',
        'betterConfiger.import.cancelled': 'Import cancelled',
        'betterConfiger.import.title': 'Import config package',
        'betterConfiger.import.mergeButton': 'Merge (recommended)',
        'betterConfiger.import.replaceButton': 'Replace sections',
        'betterConfiger.export.done': 'Exported',
        'betterConfiger.export.failed': 'Export failed',
        'betterConfiger.export.sensitiveTitle': 'Export sensitive section?',
        'betterConfiger.export.sensitiveQuestion': 'The exported file will contain secrets or credentials in recoverable form. Continue?',
        'betterConfiger.plugin.core': 'Core',
        'betterConfiger.plugin.terminal': 'Terminal',
        'betterConfiger.plugin.ssh': 'SSH',
        'betterConfiger.plugin.settings': 'Settings',
        'betterConfiger.plugin.local': 'Local Terminal',
        'betterConfiger.plugin.serial': 'Serial',
        'betterConfiger.plugin.telnet': 'Telnet',
        'betterConfiger.plugin.linkifier': 'Clickable Links',
        'betterConfiger.plugin.electron': 'Electron (platform)',
    },
    zh: {
        'betterConfiger.title': '配置管理',
        'betterConfiger.description': '查看、修改、导入导出 config.yaml 的各个配置段',
        'betterConfiger.toolbar.import': '导入配置包…',
        'betterConfiger.toolbar.exportAll': '导出全部…',
        'betterConfiger.hint.select': '在左侧选择一个配置段',
        'betterConfiger.nav.other': '其他（无来源声明）',
        'betterConfiger.nav.shared': '共享',
        'betterConfiger.nav.sensitive': '敏感',
        'betterConfiger.editor.current': '当前值（config.yaml）',
        'betterConfiger.editor.defaults': '默认值（只读）',
        'betterConfiger.editor.notSet': 'config.yaml 中未设置，当前使用默认值。在下方输入 YAML 即可覆盖。',
        'betterConfiger.editor.valid': 'YAML 语法有效',
        'betterConfiger.editor.invalid': 'YAML 语法错误',
        'betterConfiger.editor.save': '保存并应用',
        'betterConfiger.editor.discard': '放弃修改',
        'betterConfiger.editor.export': '导出',
        'betterConfiger.editor.cancel': '取消',
        'betterConfiger.editor.saved': '配置段已保存',
        'betterConfiger.warn.restart': '该段中的部分设置需重启 Tabby 后才会生效。',
        'betterConfiger.warn.profiles': 'profiles 为结构化数据（其 ID 被 groups、热键引用），手改可能破坏引用——专用表单已在规划中。',
        'betterConfiger.warn.sensitive': '该段为敏感配置（密钥/加密标志/同步凭据），手改或导入可能导致数据无法解密或同步指向他人账号。',
        'betterConfiger.warn.orphan': '没有已安装的插件声明该段——可能是已卸载插件的遗留配置。',
        'betterConfiger.import.notAPackage': '所选文件不是 BetterConfiger 配置包',
        'betterConfiger.import.badJson': '无法将所选文件解析为 JSON',
        'betterConfiger.import.failed': '导入失败',
        'betterConfiger.import.applied': '配置包已应用',
        'betterConfiger.import.cancelled': '已取消导入',
        'betterConfiger.import.title': '导入配置包',
        'betterConfiger.import.mergeButton': '合并（推荐）',
        'betterConfiger.import.replaceButton': '替换配置段',
        'betterConfiger.export.done': '已导出',
        'betterConfiger.export.failed': '导出失败',
        'betterConfiger.export.sensitiveTitle': '导出敏感配置段？',
        'betterConfiger.export.sensitiveQuestion': '导出的文件将包含可恢复形态的密钥或凭据。确定继续？',
        'betterConfiger.plugin.core': '核心',
        'betterConfiger.plugin.terminal': '终端',
        'betterConfiger.plugin.ssh': 'SSH',
        'betterConfiger.plugin.settings': '设置',
        'betterConfiger.plugin.local': '本地终端',
        'betterConfiger.plugin.serial': '串口',
        'betterConfiger.plugin.telnet': 'Telnet',
        'betterConfiger.plugin.linkifier': '可点击链接',
        'betterConfiger.plugin.electron': 'Electron（平台）',
    },
}

/** Locale normalization: zh-CN/zh-TW/zh-Hans → zh; anything unknown → en. */
function tableFor (locale: string | null | undefined): Record<string, string> {
    if (locale && locale.toLowerCase().startsWith('zh')) {
        return TRANSLATIONS['zh']
    }
    return TRANSLATIONS['en']
}

/** Standalone lookup for non-DI contexts (the settings provider title). */
export function translateText (locale: string | null | undefined, key: string): string {
    return tableFor(locale)[key] ?? TRANSLATIONS['en'][key] ?? key
}

/** Tiny translator over our own tables, locale taken from tabby-core's
 *  LocaleService. Components call t() from templates; language switches are
 *  picked up through localeChanged$ (re-render follows from Zone-triggered
 *  change detection). */
@Injectable({ providedIn: 'root' })
export class BetterConfigerTranslator {
    constructor (private localeService: LocaleService) { }

    t (key: string): string {
        return translateText(this.localeService.getLocale(), key)
    }

    get locale (): string {
        return this.localeService.getLocale()
    }

    get localeChanged$ () {
        return this.localeService.localeChanged$
    }
}
