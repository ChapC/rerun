export function isString(obj: any) : obj is string {
    return (typeof obj) === 'string';
}

export function isNumber(obj: any) : obj is Number {
    return (typeof obj) === 'number';
}