import _ from "lodash-es";

const regexpIsoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;

export async function serializeData(data) {
  if (data) {
    for await(let [property, value] of Object.entries(data)) {
      try {
        if (value?.constructor?.name === 'File') {
          data[property] = await fileToBase64(value);
        } else if (value?.constructor?.name === 'Buffer') {
          data[property] = bufferToBase64(value);
        } else if (Array.isArray(value)) { // Array
          await value.map(async (arrayValue, index) => {
            if (_.isPlainObject(arrayValue)) {
              await serializeData(arrayValue);
            } else if (arrayValue?.constructor?.name === 'File') {
              value[index] = await fileToBase64(arrayValue)
            } else if (arrayValue?.constructor?.name === 'Buffer') {
              value[index] = bufferToBase64(arrayValue)
            }
          });
        } else if (_.isPlainObject(value)) { // Is an object, not a reference nor a date!
          await serializeData(value)
        }
      } catch (e) {
        console.error(e);
      }
    }
    return data;
  }
}

export async function parseData(data) {
  if (data) {
    for await(let [property, value] of Object.entries(data)) {
      if (value?.customType === 'file') {
        data[property] = await base64ToFile(value);
      } else if (value?.customType === 'buffer') {
        data[property] = base64ToBuffer(value);
      } else if (regexpIsoDate.test(value)) {
        data[property] = new Date(value);
      } else if (Array.isArray(value)) { // Array
        await value.map(async (arrayValue, index) => {
          if (_.isPlainObject(arrayValue)) {
            await serializeData(arrayValue);
          } else if (arrayValue?.customType === 'file') {
            value[index] = await base64ToFile(arrayValue)
          } else if (arrayValue?.customType === 'buffer') {
            value[index] = base64ToBuffer(arrayValue)
          } else if (regexpIsoDate.test(arrayValue)) {
            value[index] = Date(arrayValue)
          }
        });
      } else if (_.isPlainObject(value)) { // Is an object, not a reference nor a date!
        await serializeData(value)
      }
    }
    return data;
  }
}

const fileToBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = () => resolve({customType: 'file', dataUrl: reader.result, name: file.name, type: file.type});
  reader.onerror = error => reject(error);
});

const base64ToFile = (base64) => fetch(base64.dataUrl)
  .then(res => res.blob())
  .then(blob => {
    return new File([blob], base64.name, {type: base64.type})
  })

const bufferToBase64 = buffer => ({customType: 'buffer', string: buffer.toString('base64')})

const base64ToBuffer = (base64) => Buffer.from(base64.string, 'base64');