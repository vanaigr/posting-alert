interface ViteTypeOptions {
     strictImportMetaEnv: unknown
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}

interface ImportMetaEnv {
    readonly VITE_SERVER_URL: string
}
