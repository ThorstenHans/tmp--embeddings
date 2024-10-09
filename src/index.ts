import { Kv, Llm, ResponseBuilder, Router, Sqlite } from "@fermyon/spin-sdk";
import { EmbeddingModels } from "@fermyon/spin-sdk/lib/llm";
import { parse } from 'node-html-parser';

const router = Router();
const decoder = new TextDecoder();
const BASE_URL = "https://www.fermyon.com/blog/"

interface EmbeddingRequest {
    blogPath: string
}

interface WebpageData {
    title: string,
    description: string
}

router.get("/list-table", (_, req, res) => listTable(req, res));
router.post("/embeddings", async (_, req, res) => createEmbeddings(await req.arrayBuffer(), res));
router.post("/recommendations", async (_, req, res) => getRecommendations(await req.arrayBuffer(), res));

export async function handler(req: Request, res: ResponseBuilder) {
    return await router.handleRequest(req, res, {});
}

async function createEmbeddings(reqBody: ArrayBuffer, res: ResponseBuilder) {
    let data = JSON.parse(decoder.decode(reqBody)) as EmbeddingRequest;
    let db = Sqlite.openDefault();

    let { title, description } = await fetchDataFromWebpage(BASE_URL + data.blogPath);

    let embeddingResult = Llm.generateEmbeddings(EmbeddingModels.AllMiniLmL6V2, [description]);
    let embedding = embeddingResult.embeddings[0];

    db.execute("INSERT INTO blog_posts (url, title, description, embedding) VALUES(?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,embedding=excluded.embedding", [data.blogPath, title, description, JSON.stringify(embedding)]);
    console.log("successfully inserted data");
    updateVirtualTable();
    res.status(200);
    res.set({ "content-type": "text/plain" });
    res.send(`inserted embedding for ${data.blogPath}\n`);
}

async function fetchDataFromWebpage(url: string): Promise<WebpageData> {
    let response = await fetch(url);
    let html = await response.text();
    let root = parse(html);
    let title = root.querySelector('h1')?.innerText || "";
    let description = root.querySelector('meta[name="description"]');
    return {
        title: unescapeHTML(title),
        description: description?.attributes.content || ""
    };
}

function unescapeHTML(str: string): string {
    return str.replace(
        /&amp;|&lt;|&gt;|&#39;|&quot;|&#x3D;|&#x27;/g,
        tag =>
        ({
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&#39;': "'",
            '&quot;': '"',
            '&#x3D;': '=',
            '&#x27;': "'"
        }[tag] || tag)
    );
}

function getRecommendations(reqBody: ArrayBuffer, res: ResponseBuilder) {
    let store = Kv.openDefault();
    let data = JSON.parse(decoder.decode(reqBody)) as EmbeddingRequest;

    if (store.exists(data.blogPath)) {
        let cache = store.getJson(data.blogPath);
        if (!checkCacheExpiry(Date.now(), cache.time)) {
            console.log("responding from cache");
            res.status(200);
            res.set({ "content-type": "application/json" });
            res.send(JSON.stringify(cache.content));
            return
        }
    }
    let db = Sqlite.openDefault();

    let descriptionResult = db.execute("select description from blog_posts where url = ?", [data.blogPath]);
    let description = descriptionResult.rows[0][0] as string;
    let embedding = Llm.generateEmbeddings(EmbeddingModels.AllMiniLmL6V2, [description]).embeddings[0];
    let values = db.execute("select rowid from vss_blog_posts where vss_search(embedding, ?) limit 6;", [JSON.stringify(embedding)]);

    let index: number[] = [];
    values.rows.map((k) => {
        index.push(k[0] as number);

    })
    index.shift();
    let articleResult = db.execute("select url,title from blog_posts where rowid in (?,?,?,?,?)", [...index]);
    let posts: any = [];
    articleResult.rows.map(k => {
        //@ts-ignore
        posts.push({ blogPath: k[0], title: k[1] })
    });
    let cache = {
        time: Date.now(),
        content: posts
    };
    // cache responses for 5 minutes
    store.setJson(data.blogPath, cache);
    res.status(200);
    res.set({ "content-type": "application/json" });
    res.set({ "Access-Control-Allow-Origin": "*" });
    res.set({ "Access-Control-Allow-Headers": "*" });
    res.send(JSON.stringify(posts));
    return
}

function updateVirtualTable() {
    let db = Sqlite.openDefault();
    db.execute("DELETE FROM vss_blog_posts", []);
    db.execute("INSERT INTO vss_blog_posts(rowid,embedding) SELECT rowid,embedding FROM blog_posts;", []);
    console.log("updated virtual table entries successfully");
}

function checkCacheExpiry(currentTime: number, cachedTime: number) {
    return (currentTime - cachedTime) > 300000;
}


function listTable(_: Request, res: ResponseBuilder) {
    let db = Sqlite.openDefault();
    let url = db.execute("SELECT url FROM blog_posts", []);
    res.status(200);
    res.set({ "content-type": "application/json" });
    res.send(JSON.stringify(url));
}