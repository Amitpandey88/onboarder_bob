export function askConfig(env = process.env) {
    const baseUrl = (env.ONBOARDER_AI_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
    const model = env.ONBOARDER_AI_MODEL || env.OPENAI_MODEL || '';
    const apiKey = env.ONBOARDER_AI_API_KEY || env.OPENAI_API_KEY || '';
    if (!baseUrl || !model)
        return null;
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new Error('The AI base URL is invalid. Set ONBOARDER_AI_BASE_URL to an http(s) endpoint.');
    }
    if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('The AI base URL must use http or https.');
    return { baseUrl, model, apiKey };
}
export function askSetupMessage() {
    return [
        '  To use `ask`, set an OpenAI-compatible endpoint and model:',
        '    ONBOARDER_AI_BASE_URL=https://api.openai.com/v1',
        '    ONBOARDER_AI_MODEL=<your-model>',
        '    ONBOARDER_AI_API_KEY=<your-key>  (optional for local endpoints)',
        '  The question and selected repository context go to that endpoint only when you run `ask`.',
    ].join('\n');
}
export async function askModel(question, context, config, fetchImpl = fetch) {
    if (!question.trim())
        return '  Ask a question, for example: ask Where should I start?';
    const url = `${config.baseUrl}/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    const isAzure = /\.openai\.azure\.com|\.cognitiveservices\.azure\.com/i.test(config.baseUrl);
    if (config.apiKey)
        headers[isAzure ? 'api-key' : 'authorization'] = isAzure ? config.apiKey : `Bearer ${config.apiKey}`;
    const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: config.model,
            stream: false,
            ...(isAzure ? { max_completion_tokens: 900 } : { max_tokens: 900 }),
            messages: [
                { role: 'system', content: 'You explain a codebase using only the supplied scan facts. Say when the evidence is insufficient. Cite repository file paths when relevant. Keep the answer concise.' },
                { role: 'user', content: `Repository context:\n${context.slice(0, 18000)}\n\nQuestion: ${question}` },
            ],
        }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
        throw new Error(`The AI endpoint returned ${response.status}. Check the endpoint and model.`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    const answer = Array.isArray(content) ? content.map((part) => part.text || '').join('') : content;
    if (!answer?.trim())
        throw new Error('The AI endpoint returned no answer.');
    return answer.trim();
}
