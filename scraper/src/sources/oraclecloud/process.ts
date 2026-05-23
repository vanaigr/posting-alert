import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import * as U from '../../lib/util.ts'

const companies = new Map<string, string[]>()

function addUrl(urlString: string) {
    const url = new URL(urlString)

    const d = url.hostname.split('.')
    if(d.length !== 5) return
    if(!(d[1] === 'fa' && d[3] === 'oraclecloud' && d[4] === 'com')) return

    const p = url.pathname.split('/')
    const site = p.find(it => it.startsWith('CX_')) ?? 'CX_1'

    const parts = [d[0], d[2], site]
    companies.set(U.getHash(...parts), parts)
}

const rl = readline.createInterface({
    input: fs.createReadStream(path.join(import.meta.dirname, 'archive-urls.txt')),
    crlfDelay: Infinity,
})

for await (const url of rl) {
    addUrl(url)
}

console.log('Found', companies.size, 'companies')

fs.writeFileSync(
    path.join(import.meta.dirname, 'companies.json'),
    '[\n'
        + [...companies.values()].map(it => ' ' + JSON.stringify(it)).join(',\n')
        + '\n]',
)
