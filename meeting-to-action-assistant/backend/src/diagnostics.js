const secretPattern = /\b(?:gsk_|sk-)[A-Za-z0-9_-]{8,}\b/gi;
const bearerPattern = /\bBearer\s+[^\s"']+/gi;

export function safeErrorDetail(error, omittedValues = []) {
  let detail=String(error?.message||'Unknown server error.');
  for(const value of omittedValues){
    if(typeof value==='string'&&value.length>0) detail=detail.replaceAll(value,'[redacted]');
  }
  return detail.replace(secretPattern,'[redacted]').replace(bearerPattern,'Bearer [redacted]').slice(0,500);
}

export function safeValidationIssues(error) {
  return Array.isArray(error?.issues)
    ? error.issues.map(issue=>({field:issue.path?.join('.')||'$root',code:issue.code||'invalid'}))
    : undefined;
}
