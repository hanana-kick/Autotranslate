// Documented Notion REST responses; synthetic IDs, no live workspace credential.
export const NOTION_IDS = {
  conceptDatabase: '11111111-1111-4111-8111-111111111111',
  termDatabase: '22222222-2222-4222-8222-222222222222',
  conceptSource: '33333333-3333-4333-8333-333333333333',
  termSource: '44444444-4444-4444-8444-444444444444',
  conceptPage: '55555555-5555-4555-8555-555555555555',
  concept: '66666666-6666-4666-8666-666666666666',
  japanese: '77777777-7777-4777-8777-777777777777',
  korean: '88888888-8888-4888-8888-888888888888'
};
const rich = text => [{ type: 'text', text: { content: text }, plain_text: text }];
const text = (value, type = 'rich_text') => ({ type, [type]: rich(value) });
const select = name => ({ type: 'select', select: { name } });
const column = (id, type, extra = {}) => ({ id, type, [type]: {}, ...extra });
const list = (results, next_cursor = null) => ({ object: 'list', results, has_more: next_cursor !== null, next_cursor });

export function notionFixture() {
  const ids = NOTION_IDS;
  const state = { calls: [], fail: false, target: '네코타 츠나', termName: 'Expression' };
  const term = (id, language, value) => ({ object: 'page', id, archived: false, in_trash: false,
    properties: {
      [state.termName]: { id: 'term', ...text(value, 'title') },
      '언어': { id: 'language', ...select(language) },
      '원문': { id: 'concept', type: 'relation', relation: [{ id: ids.conceptPage }], has_more: false },
      '표현 묶음': { id: 'group', ...text('인물 전체 이름') },
      '표현 특성': { id: 'traits', type: 'multi_select', multi_select: [{ name: '기본형' }] },
      '설명': { id: 'description', ...text('인물의 활동명. 다른 인물 및 일반 단어와 구별한다.') }
    }
  });
  state.response = (url, method, body = {}) => {
    const path = new URL(url).pathname;
    state.calls.push({ path, method, body });
    if (state.fail) return { status: 503, json: { object: 'error', code: 'service_unavailable', message: 'fixture unavailable' } };
    let result;
    if (path === `/v1/databases/${ids.conceptDatabase}`) result = { object: 'database', id: ids.conceptDatabase, data_sources: [{ id: ids.conceptSource, name: 'Concepts' }] };
    else if (path === `/v1/databases/${ids.termDatabase}`) result = { object: 'database', id: ids.termDatabase, data_sources: [{ id: ids.termSource, name: 'Expressions' }] };
    else if (path === `/v1/data_sources/${ids.conceptSource}`) result = { object: 'data_source', id: ids.conceptSource, parent: { type: 'database_id', database_id: ids.conceptDatabase }, properties: {
      '개념 ID': column('concept-id', 'title'), '개념 유형': column('type', 'select'), '정의': column('definition', 'rich_text')
    } };
    else if (path === `/v1/data_sources/${ids.termSource}`) result = { object: 'data_source', id: ids.termSource, parent: { type: 'database_id', database_id: ids.termDatabase }, properties: {
      [state.termName]: column('term', 'title'), '언어': column('language', 'select'),
      '원문': column('concept', 'relation', { relation: { database_id: ids.conceptDatabase, data_source_id: ids.conceptSource, type: 'single_property', single_property: {} } }),
      '표현 묶음': column('group', 'rich_text'), '표현 특성': column('traits', 'multi_select'), '설명': column('description', 'rich_text')
    } };
    else if (path === `/v1/data_sources/${ids.conceptSource}/query`) result = list([{ object: 'page', id: ids.conceptPage, archived: false, in_trash: false, properties: {
      '개념 ID': { id: 'concept-id', ...text(ids.concept, 'title') }, '개념 유형': { id: 'type', ...select('인물') }, '정의': { id: 'definition', ...text('네코타 츠나라는 버추얼 탤런트 활동명.') }
    } }]);
    else if (path === `/v1/data_sources/${ids.termSource}/query`) result = body.start_cursor
      ? list([term(ids.korean, 'ko', state.target)])
      : list([term(ids.japanese, 'ja', '猫汰つな')], 'terms-page-2');
    else return { status: 404, json: { object: 'error', code: 'object_not_found', message: 'unexpected fixture route' } };
    return { status: 200, json: result };
  };
  state.route = async route => {
    const request = route.request();
    const response = state.response(request.url(), request.method(), request.postDataJSON() ?? {});
    await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.json) });
  };
  return state;
}
