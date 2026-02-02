require('@babel/register')({
    presets: ['@babel/preset-react', '@babel/preset-env'],
    ignore: [/node_modules/],
    extensions: ['.jsx', '.js']
});

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { minify } = require('html-minifier');
const merge = require('lodash.merge');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// تشخیص اینکه آیا برنامه به صورت EXE اجرا شده یا خیر
const isPkg = typeof process.pkg !== 'undefined';
// اگر EXE بود، مسیر اصلی پوشه کنار فایل EXE است، در غیر این صورت پوشه فعلی پروژه
const rootPath = isPkg ? path.dirname(process.execPath) : __dirname;

app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const STORAGE = {
    templates: path.join(rootPath, 'storage', 'templates'),
    data: path.join(rootPath, 'storage', 'data'),
    output: path.join(rootPath, 'storage', 'output'),
    config: path.join(rootPath, 'storage', 'config')
};

// Serve output directory for Live Preview
app.use('/preview', express.static(STORAGE.output));

// اطمینان از وجود پوشه‌ها در کنار فایل EXE
Object.values(STORAGE).forEach(dir => fs.ensureDirSync(dir));

const resolveSafePath = (baseDir, userInput) => {
    const safeBase = path.resolve(baseDir);
    const resolvedPath = path.resolve(safeBase, userInput);
    if (!resolvedPath.startsWith(safeBase)) throw new Error('Security Violation: Access Denied');
    return resolvedPath;
};

const getDirectoryTree = async (dir, relativePath = '') => {
    if (!(await fs.pathExists(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const structure = [];
    for (const entry of entries) {
        const itemPath = path.join(relativePath, entry.name);
        if (entry.isDirectory()) {
            structure.push({
                name: entry.name,
                path: itemPath,
                type: 'folder',
                children: await getDirectoryTree(path.join(dir, entry.name), itemPath)
            });
        } else {
            structure.push({
                name: entry.name,
                path: itemPath,
                type: 'file'
            });
        }
    }
    return structure;
};

// --- API ENDPOINTS ---
app.get('/api/meta', async (req, res) => {
    try {
        const templatesTree = await getDirectoryTree(STORAGE.templates);
        const dataTree = await getDirectoryTree(STORAGE.data);
        res.json({ templates: templatesTree, dataFiles: dataTree });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/meta/schema', async (req, res) => {
    try {
        const { templatePath } = req.body;
        const schemaPath = templatePath.replace(/\.(js|jsx)$/, '.schema.json');
        const fullPath = resolveSafePath(STORAGE.templates, schemaPath);
        if (await fs.pathExists(fullPath)) {
            const schema = await fs.readJson(fullPath);
            res.json({ schema });
        } else { res.json({ schema: null }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/read', async (req, res) => {
    try {
        const { type, filePath } = req.body;
        const baseDir = type === 'data' ? STORAGE.data : STORAGE.templates;
        const fullPath = resolveSafePath(baseDir, filePath);
        if (filePath.endsWith('.json')) {
            const content = await fs.readJson(fullPath);
            res.json({ content });
        } else {
            const content = await fs.readFile(fullPath, 'utf-8');
            res.json({ content });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/write', async (req, res) => {
    try {
        const { type, filePath, content, isFolder } = req.body;
        const baseDir = type === 'data' ? STORAGE.data : STORAGE.templates;
        const fullPath = resolveSafePath(baseDir, filePath);
        if (isFolder) {
            await fs.ensureDir(fullPath);
        } else {
            await fs.ensureDir(path.dirname(fullPath));
            const dataToWrite = (typeof content === 'object' && filePath.endsWith('.json')) 
                ? JSON.stringify(content, null, 4) : content;
            await fs.writeFile(fullPath, dataToWrite || (filePath.endsWith('.json') ? '{}' : ''));
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/delete', async (req, res) => {
    try {
        const { type, filePath } = req.body;
        const baseDir = type === 'data' ? STORAGE.data : STORAGE.templates;
        const fullPath = resolveSafePath(baseDir, filePath);
        await fs.remove(fullPath);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- BUILD ENGINE ---
const performBuild = async (templatePath, dataSources, outputRelPath) => {
    Object.keys(require.cache).forEach(key => {
        if (key.startsWith(STORAGE.templates)) delete require.cache[key];
    });
    let finalProps = {};
    for (const src of dataSources) {
        if (!src.filename) continue;
        const fullDataPath = resolveSafePath(STORAGE.data, src.filename);
        const content = await fs.readJson(fullDataPath);
        if (src.key) merge(finalProps, content[src.key] || {});
        else merge(finalProps, content);
    }
    const fullTemplatePath = resolveSafePath(STORAGE.templates, templatePath);
    const Component = require(fullTemplatePath);
    const App = Component.default || Component.App || Component;
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(App, finalProps));
    const minified = minify(html, { collapseWhitespace: true, minifyJS: true, minifyCSS: true });
    let finalPath = outputRelPath;
    if (!finalPath.endsWith('.html')) finalPath = path.join(finalPath, 'index.html');
    const fullOutputPath = resolveSafePath(STORAGE.output, finalPath);
    await fs.ensureDir(path.dirname(fullOutputPath));
    await fs.writeFile(fullOutputPath, minified);
    return finalPath;
};

app.post('/api/build/single', async (req, res) => {
    try {
        const { templatePath, dataSources, outputName } = req.body;
        const resultPath = await performBuild(templatePath, dataSources, outputName);
        res.json({ success: true, path: resultPath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/build/batch', async (req, res) => {
    try {
        const { templatePath, dataFolder, outputBase } = req.body;
        const fullDataDir = resolveSafePath(STORAGE.data, dataFolder);
        const files = await fs.readdir(fullDataDir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        const results = [];
        for (const file of jsonFiles) {
            const dataPath = path.join(dataFolder, file);
            const outputName = path.join(outputBase, file.replace('.json', ''));
            try {
                const builtPath = await performBuild(templatePath, [{filename: dataPath}], outputName);
                results.push({ file, status: 'success', path: builtPath });
            } catch (err) { results.push({ file, status: 'error', error: err.message }); }
        }
        res.json({ success: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Saino Forge EXE running on port ${PORT}`));
