import { parsePlaylistId, playlistLinks } from './tutorial-videos';

describe('tutorial videos', () => {
  it('reads the playlist id from the link the owner shared, tracker and all', () => {
    expect(
      parsePlaylistId(
        'https://youtube.com/playlist?list=PLMh1t_lzQ2ZM&si=SrN32EVyhEY32GVU',
      ),
    ).toBe('PLMh1t_lzQ2ZM');
  });

  it('takes the other shapes a playlist arrives in', () => {
    const id = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
    expect(parsePlaylistId(id)).toBe(id);
    expect(parsePlaylistId(`  www.youtube.com/playlist?list=${id}  `)).toBe(id);
    expect(
      parsePlaylistId(
        `https://www.youtube.com/watch?v=lRuCCtrRUhA&list=${id}&index=2`,
      ),
    ).toBe(id);
    expect(parsePlaylistId(`https://youtu.be/lRuCCtrRUhA?list=${id}`)).toBe(id);
    expect(parsePlaylistId(`https://m.youtube.com/playlist?list=${id}`)).toBe(
      id,
    );
  });

  it('refuses what is not a YouTube playlist', () => {
    expect(parsePlaylistId('')).toBeNull();
    expect(
      parsePlaylistId('https://www.youtube.com/watch?v=lRuCCtrRUhA'),
    ).toBeNull();
    expect(
      parsePlaylistId('https://evil.example/playlist?list=PLMh1t_lzQ2ZM'),
    ).toBeNull();
    expect(
      parsePlaylistId('https://www.youtube.com/playlist?list=<script>'),
    ).toBeNull();
    expect(parsePlaylistId('not a link')).toBeNull();
  });

  it('opens on YouTube, and plays in the privacy-enhanced player', () => {
    expect(playlistLinks('PLMh1t_lzQ2ZM')).toEqual({
      url: 'https://www.youtube.com/playlist?list=PLMh1t_lzQ2ZM',
      embedUrl:
        'https://www.youtube-nocookie.com/embed/videoseries?list=PLMh1t_lzQ2ZM',
    });
  });
});
