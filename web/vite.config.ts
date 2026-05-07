import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const base = import.meta.dirname

export default defineConfig(() => {
    return {
        root: path.join(base, 'src'),
        publicDir: path.join(base, 'src', 'public'),
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
