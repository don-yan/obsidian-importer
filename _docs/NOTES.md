# Dev Notes

## SQL Lite

### References:

- https://github.com/RhetTbull/apple-notes-parser
- https://ciofecaforensics.com/2020/09/18/apple-notes-revisited-protobuf/

-------------


### `Z_PRIMARYKEY` Table

| Z_ENT_ | Z_NAME                | Z_SUPER | Z_MAX |
|--------|-----------------------|---------|-------|
| 1      | ICCloudState          | 0       | 58583 |
| 2      | ICCloudSyncingObject  | 0       | 5871  |
| 3      | ICAccountData         | 2       | 0     |
| 4      | ICAttachment          | 2       | 0     |
| 5      | ICAttachmentPreviewImage | 2     | 0     |
| 6      | ICDeviceMigrationState | 2     | 0     |
| 7      | ICHash                | 2       | 0     |
| 8      | ICInlineAttachment    | 2       | 0     |
| 9      | ICLegacyTombstone     | 2       | 0     |
| 10     | ICMedia               | 2       | 0     |
| 11     | ICNote                | 2       | 0     |
| 12     | ICNoteContainer       | 2       | 0     |
| 13     | ICAccount             | 12      | 0     |
| 14     | ICFolder              | 12      | 0     |
| 15     | ICInvitation          | 0       | 102   |
| 16     | ICLocation            | 0       | 1     |
| 17     | ICAttachmentLocation  | 16      | 0     |
| 18     | ICNoteData            | 0       | 3929  |
| 19     | ICNoteParticipant     | 0       | 174   |
| 20     | ICServerChangeToken   | 0       | 11    |
| 1601   | CHANGE                | 0       | 142359|
| 1602   | TRANSACTION           | 0       | 51848 |
| 1603   | TRANSACTIONSTRING     | 0       | 1488  |


============

### SQLite Snippets

##### Get all tags for a note

```sqlite

SELECT Z_PK, ZALTTEXT, ZDISPLAYTEXT, Z_ENT, ZNOTE, ZNOTE1, ZACCOUNT1
FROM ZICCLOUDSYNCINGOBJECT
WHERE (ZNOTE = 2656 OR ZNOTE1 = 2656 OR ZATTACHMENT = 2656)
  AND ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.hashtag'
;

```

