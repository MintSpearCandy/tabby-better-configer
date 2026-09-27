declare module '*.component.scss' {
    const content: string
    export default content
}

// tabby-settings is provided by the Tabby host at runtime (webpack external);
// this is a compile-time-only declaration. Only what we consume is declared.
// NOTE: do NOT declare module 'tabby-core' the same way — that would shadow
// its real typings from the npm devDependency.
declare module 'tabby-settings' {
    export abstract class SettingsTabProvider {
        id: string
        icon: string
        /** declared as an accessor so subclasses may override with a getter
         *  (the real host class has a plain property; identical at runtime) */
        get title (): string
        set title (v: string)
        weight: number
        prioritized: boolean
        getComponentType (): any
    }
}
