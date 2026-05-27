import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const base = import.meta.dirname

export default defineConfig(({ mode }) => {
    //const env = loadEnv(mode, base, '')

    return {
        root: path.join(base, 'src'),
        publicDir: path.join(base, 'src', 'public'),
        envDir: base,
        build: {
            outDir: path.join(base, 'dist'),
            emptyOutDir: true,
        },
        plugins: [
            react(),
            tailwindcss(),
        ],
    }
})
