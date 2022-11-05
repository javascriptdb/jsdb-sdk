const regexpIsoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;

export async function traverse(obj: any, replacer: (value: any) => any) {
    if (obj) await Promise.all(Object.entries(obj).map(async ([key, value]) => {
        // Key is either an array index or object key
        const newValue = await replacer(value);
        if (newValue) {
            if (typeof obj.sort === 'function') {//Is array
                obj[Number(key)] = newValue;
            } else {
                obj[key] = newValue;
            }
        } else if (typeof value === 'object') { // Only continue traversing plain objects
            await traverse(value, replacer);
        }
    }));
    return obj;
};

// @ts-ignore
export async function outgoingReplacer(value: any) {
    if (value?.constructor?.name === 'File') {
        return await fileToBase64(value);
    } else if (value?.constructor?.name === 'Buffer') {
        return bufferToBase64(value);
    }
}

// @ts-ignore
export async function incomingReplacer(value: any) {
    if (value?.customType === 'file') {
        return await base64ToFile(value);
    } else if (value?.customType === 'buffer') {
        return base64ToBuffer(value);
    } else if (regexpIsoDate.test(value)) {
        return new Date(value);
    }
}

const fileToBase64 = (file: File) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve({customType: 'file', dataUrl: reader.result, name: file.name, type: file.type});
    reader.onerror = error => reject(error);
});

const base64ToFile = (base64: { name: string, dataUrl: string, type: string }) => fetch(base64.dataUrl)
    .then(res => res.blob())
    .then(blob => {
        return new File([blob], base64.name, {type: base64.type})
    })

const bufferToBase64 = (buffer: Buffer) => ({customType: 'buffer', string: buffer.toString('base64')})

const base64ToBuffer = (base64: { string: string }) => Buffer.from(base64.string, 'base64');

export class CustomStore {
    value: any = undefined;
    subscriptions: Set<(value: any) => any> = new Set();

    subscribe(callback: (value: any) => any) {
        if(typeof callback !== 'function') throw new Error('Subscribe parameter must be a function.')
        this.subscriptions.add(callback);
        callback(this.value);
        return () => this.subscriptions.delete(callback);
    }

    set(value: any) {
        this.value = value;
        this.notify(this.value);
    }

    update(callback: (value: any) => any) {
        if(typeof callback !== 'function') throw new Error('Update parameter must be a function.')
        this.value = callback(this.value);
        this.notify(this.value);
    }

    notify(value: any) {
        this.subscriptions.forEach(callback => callback(value));
    }
}