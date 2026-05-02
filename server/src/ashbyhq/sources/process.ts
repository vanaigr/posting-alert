import fs from 'node:fs'
import path from 'node:path'

/*

curl -G 'https://web.archive.org/cdx/search/cdx' \
    --data-urlencode 'url=jobs.ashbyhq.com/*' \
    --data-urlencode 'output=json' \
    --data-urlencode 'fl=original' \
    --data-urlencode 'collapse=urlkey' \
    > ashby-urls.json
*/

const urls: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'ashby-urls.json')).toString())

const prefix = 'https://jobs.ashbyhq.com/'

const companies = new Set<string>()
for(const [url, ...huh] of urls) {
    if(huh.length > 0) console.log('huh')
    if(!url.startsWith(prefix)) continue

    const nextSlashI = Math.min(
        goodIndexOf(url, '/', prefix.length),
        goodIndexOf(url, '?', prefix.length),
        goodIndexOf(url, '#', prefix.length),
    )

    const companySlug = url.slice(prefix.length, nextSlashI)
    const name = decodeURIComponent(companySlug).toLowerCase()
    if(/^root\..+?_.+?_.+?_.+?_/.test(name)) continue
    companies.add(name)
}

fs.writeFileSync(
    path.join(import.meta.dirname, 'companyNames.json'),
    JSON.stringify([...companies]),
)

function goodIndexOf(str: string, search: string, position?: number) {
    const index = str.indexOf(search, position)
    if(index === -1) return str.length
    return index
}
