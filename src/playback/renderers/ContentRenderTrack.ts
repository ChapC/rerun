import { ContentBlock } from "../ContentBlock";
import { PooledContentRenderer } from "./RendererPool";
/* 
    Connects an active renderer with the block it's currently playing.
    The player manages a collection of ContentRenderTracks and decides which renderers should be on screen by sending them to the RenderHierarchy.
*/
export default class ContentRenderTrack {
    //The block and renderer currently being displayed in the RenderHierarchy
    activeBlock: ContentBlock = null;
    activeRenderer: PooledContentRenderer = null;
} 