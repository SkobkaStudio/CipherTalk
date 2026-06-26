class File {
  constructor(data) {
    this.id = data.id;
    this.filename = data.filename;
    this.original_name = data.original_name;
    this.size = data.size;
    this.mimetype = data.mimetype;
    this.uploader_id = data.uploader_id;
    this.created_at = data.created_at || Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      filename: this.filename,
      original_name: this.original_name,
      size: this.size,
      mimetype: this.mimetype,
      uploader_id: this.uploader_id,
      created_at: this.created_at
    };
  }
}

module.exports = File;