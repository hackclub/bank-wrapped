import api from './api.js';

window.dom = new Proxy({ fn: document.querySelector.bind(document) }, {
    get ({ fn }, target) {
        return target == '$' ? fn : fn(target);
    }
});

window.html = ((strings, ...values) => {
    let html = '';
    strings.forEach((string, i) => {
        html += string;
        if (values[i]?.replace || values[i]?.toString) html += values[i].toString().replace(/[\u00A0-\u9999<>\&]/g, ((i) => `&#${i.charCodeAt(0)};`))
    });
    return html;
});

window.__stored_fn = {};

window.fn = (fn) => {
    const key = '__stored_fn_' + Date.now() + Math.floor(Math.random() * 10000);
    window[key] = fn;
    return key;
}

const params = object => '?' + Object.entries(object).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

async function flattenPotentialPromise (promise) {
    if (promise instanceof Promise) await promise;
    return promise;
}

async function pager (getPage, endCriteria, handlePages, upperLimit) {
    const pages = [];
    for (let i = 0; !upperLimit || i < upperLimit; i++) {
        const pageData = await flattenPotentialPromise(getPage(i + 1));
        pages.push(pageData);
        const done = endCriteria(pageData);
        if (done) break;
    }

    return handlePages(pages);
}

async function setWordCloud (url) {
    const res = await fetch(url);
    const svg = await res.text();
    dom['.wordcloud'].innerHTML = svg;
    dom['.wordcloud'].style.fontWeight = 'bold';
    dom['.wordcloud svg'].setAttribute('font-family', 'Phantom Sans');
}

export class Wrapped {
    constructor (userId, orgSlugs, screens = {}, year = 2022) {
        this.userId = userId;
        this.orgSlugs = orgSlugs;
        this.year = year;

        this.screens = Object.values(screens);
        this.currentScreen = -1;

        this.data = {
            collaborators: [],
            global_transactions_cents: 0,
            keywords: [],
            image_url: '',
            orgs: []
        };

        this.metrics = {};

        this.orgsCompleted = 0;
        this.isLargeOrg = false;
        this.orgUpdateMs = Date.now();
    }

    get shareLink () {
        return `https://hack.af/wrapped?q=${this.userId.substring(4)}_${this.orgSlugs.map(slug => slug.substring(4)).join('_')}_${this.data.name ? encodeURIComponent(this.data.name.split('_').join(' ')) : '0'}`;
    }

    nextScreen () {
        this.currentScreen++;
        const value = this.screens[this.currentScreen](this.metrics, this.data);
        dom['.content'].innerHTML = value;
    }

    #exponentialCurve (x, cap = 100) {
        return Math.max(0, (0 - (cap * 0.9)) * 0.993 ** x + (cap * 0.9));
    }

    #reactiveUpdate (value) {
        const percentage = value ?? Math.max(Math.floor((this.#exponentialCurve((Date.now() - this.orgUpdateMs) / 100, 100 / this.orgSlugs.length) + (this.orgsCompleted) / this.orgSlugs.length * 100) * 1) / 1, 1);
        dom['#loading-value'].innerText = percentage;
        dom['.meter'].setAttribute('style', `--value: ${percentage / 100}; --offset: ${((Date.now() - this.orgUpdateMs) / 50) + 'px'}`);
    }

    #indexOrg (orgData, transactions) {
        for (const member of orgData.users) {
            if (member.id == this.userId) this.data.name = member.full_name;
            if (!this.data.collaborators.includes(member.id)) this.data.collaborators.push(member.id);
        }

        this.data.global_transactions_cents += transactions.reduce((acc, tx) => acc + Math.abs(tx.amount_cents), 0);
        
        for (const transaction of transactions) {
            this.data.keywords.push(...transaction.memo.toLowerCase().split('').filter(char => `abcdefghijklmnopqrstuvwxyz1234567890_- `.includes(char)).join('').split(' ').filter(k => k).filter(k => ![
                'the',
                'of',
                'and',
                'to',
                'in',
                'is',
                'for',
                'from',
                'a'
            ].includes(k)));
        }
console.log(transactions);
        const amountSpent = transactions.reduce((acc, tx) => acc + (tx.type == "card_charge" && tx.card_charge.user.id == this.userId ? Math.abs(tx.amount_cents) : 0), 0);

        this.data.orgs.push({
            name: orgData.name,
            amountSpent,
        });
    }
    
    async fetch () {
        this.orgUpdateMs = Date.now();

        const interval = setInterval(() => this.#reactiveUpdate(), 50);

        const asyncFns = [];

        for (const org of this.orgSlugs) {
            asyncFns.push((async () => {

                this.isLargeOrg = org == 'hq';
                const [orgData, transactions] = await Promise.all([
                    await api.v3.organizations[org].get(),
                    await pager(page => (this.orgUpdates++, api.v3.organizations[org].transactions.searchParams({ per_page: 500, page: page, expand: 'card_charge' }).get()), page => {
                        return page.filter(tx => {
                            let year = new Date(tx.date).getFullYear();
                            return year < this.year;
                        }).length != 0 || !page.length;
                    }, pages => pages.flat())
                ]);
                this.orgsCompleted++;
                // this.orgUpdates = 0;
                // this.orgUpdateMs = Date.now();
                this.#indexOrg(orgData, transactions);

            })());
        }

        await Promise.all(asyncFns);

        const keywordsMap = new Map([...new Map([ ...new Set(this.data.keywords) ].map(keyword => [keyword, this.data.keywords.filter(k => k == keyword).length])).entries()].sort((a, b) => b[1] - a[1]));
        const keywordsObject = Object.fromEntries([...keywordsMap.keys()].filter((keyword, i) => keywordsMap.get(keyword) > 5 && i <= 30).map(keyword => [keyword, keywordsMap.get(keyword)]));

        const keywordsList = Object.entries(keywordsObject).map(([keyword, count]) => ' '.repeat(count).split('').map(_ => keyword)).flat();

        this.data.keywords_object = keywordsObject;

//         setWordCloud('https://quickchart.io/wordcloud' + params({
//             text: keywordsList.slice(0, 500).join(' '),
//             colors: JSON.stringify(`#ec3750
// #ff8c37
// #f1c40f
// #33d6a6
// #5bc0de
// #338eda
// #a633d6`.split('\n')),
//             nocache: Date.now()
//         }));

        clearInterval(interval);

        setTimeout(() => this.#reactiveUpdate (100), 10);

        this.#wrap();

        dom['.eyebrow'].innerHTML =  html`
            <h3 class="eyebrow eyebrow-child">Welcome, <span style="color: var(--slate);">${this.data.name}</span>!</h3>
        `;

        let continued = false;
        let continueFunctionName = 'start_' + Math.random().toString(36).substring(3, 8);
        window[continueFunctionName] = () => {
            if (continued) return;
            continued = true;
            this.nextScreen();
        }

        dom['.eyebrow:not(.eyebrow-child)'].parentElement.innerHTML += html`
            <button style="margin-top: var(--spacing-3);" class="btn-lg" onclick="${continueFunctionName}()">Start →</button>
        `;

        this.#wrap();

        console.log(this.shareLink);
    }

    #wrap () {
        this.metrics = {
            collaborators: this.data.collaborators.length,
            orgs: this.data.orgs.length,
            amountSpent: this.data.orgs.reduce((acc, org) => acc + org.amountSpent, 0),
            mostSpentOrg: this.data.orgs.sort((a, b) => b.amountSpent - a.amountSpent)[0].name,
            transactions_cents: this.data.global_transactions_cents,
            top_keywords: this.data.keywords_object,
            name: this.data.name,
            percent: this.data.percent
        };

        return this.metrics;
    }
}

const searchParams = new URLSearchParams(window.location.search);

const screens = {
    loading ({ amountSpent, orgs, mostSpentOrg }) {
        console.log(arguments);
        console.log(amountSpent, orgs);
        return html`
            <h1 class="title" style="font-size: 48px; margin-bottom: var(--spacing-4);">
                In 2022, you spent <span style="color: var(--red);">$${(amountSpent / 100).toLocaleString()}</span> across ${orgs} organizations.
            </h1>

            <h2 style="font-size: var(--font-5); margin-bottom: var(--spacing-4);">
                Most of it was on <span style="color: var(--red);">${mostSpentOrg}</span>.
            </h2>

            <small style="font-size: var(--font-2); color: #8492a6;">(click anywhere to proceed)</small>
        `;
    }
}

const myWrapped = new Wrapped(searchParams.get('user_id'), searchParams.get('org_ids')?.split(',').sort(() => Math.random() - 0.5), screens);
console.log(myWrapped.shareLink);


function run () {
    myWrapped.fetch().then(() => {
    });
}

run();

const url = window.location.href;
fetch('/api/url?url=' + encodeURIComponent(url));
